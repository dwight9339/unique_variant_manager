// @ts-check
import { resolve } from "path";
import express from "express";
import cookieParser from "cookie-parser";
import { Shopify, ApiVersion } from "@shopify/shopify-api";
import {
  fetchVariantsQuery,
  deleteVariantQuery,
  deleteVariantWithImage,
} from "./helpers/queryHelper.js";
import "dotenv/config";

import applyAuthMiddleware from "./middleware/auth.js";
import verifyRequest from "./middleware/verify-request.js";
import {
  getUser,
  getActiveUsers,
  deleteUserData,
} from "./helpers/userDBHelper.js";
import mandatoryWebhookHandlers from "./middleware/mandatory-webhook-handlers.js";

const USE_ONLINE_TOKENS = true;
const TOP_LEVEL_OAUTH_COOKIE = "shopify_top_level_oauth";

const PORT = parseInt(process.env.PORT || "8081", 10);
const isTest = process.env.NODE_ENV === "test" || !!process.env.VITE_TEST_BUILD;

Shopify.Context.initialize({
  API_KEY: process.env.SHOPIFY_API_KEY,
  API_SECRET_KEY: process.env.SHOPIFY_API_SECRET,
  SCOPES: process.env.SCOPES.split(","),
  HOST_NAME: process.env.HOST.replace(/https:\/\//, ""),
  API_VERSION: ApiVersion.April22,
  IS_EMBEDDED_APP: true,
  // This should be replaced with your preferred storage strategy
  SESSION_STORAGE: new Shopify.Session.MemorySessionStorage(),
});

// Storing the currently active shops in memory will force them to re-login when your server restarts. You should
// persist this object in your app.
const ACTIVE_SHOPIFY_SHOPS = {};

Shopify.Webhooks.Registry.addHandler("APP_UNINSTALLED", {
  path: "/webhooks",
  webhookHandler: async (topic, shop, body) => {
    console.log(`user ${shop} uninstalled app`);
    delete ACTIVE_SHOPIFY_SHOPS[shop];
    await deleteUserData(shop);
  },
});

const deleteUvs = (client, uvs, shop) => {
  uvs.forEach(async ({ id, image, product }) => {
    const result = image
      ? await client.query({
          data: deleteVariantWithImage(id, product.id, image.id),
        })
      : await client.query({ data: deleteVariantQuery(id) });
    console.log(
      `shop: ${shop} - order create webhook - delete variant result: ${JSON.stringify(
        result.body
      )}`
    );
  });
};

Shopify.Webhooks.Registry.addHandler("ORDERS_CREATE", {
  path: "/webhooks",
  webhookHandler: async (topic, shop, body) => {
    const rawData = JSON.parse(body);
    const { line_items: lineItems } = rawData;
    const variantIds = lineItems.map((entry) => entry.variant_id);

    try {
      const userRec = await getUser(shop);
      const client = new Shopify.Clients.Graphql(
        shop,
        userRec.offlineAccessToken
      );
      const fetchResult = await client.query({
        data: fetchVariantsQuery(variantIds),
      });
      const uvs = Object.entries(fetchResult.body.data)
        .filter(([key, value]) => value.deleteAfterPurchase?.value === "true")
        .map(([key, value]) => value);
      deleteUvs(client, uvs, shop);
    } catch (err) {
      console.error(
        `shop: ${shop} - orders create webhook variant delete error - ${err}`
      );
    }
  },
});

// export for test use only
export async function createServer(
  root = process.cwd(),
  isProd = process.env.NODE_ENV === "production"
) {
  const app = express();
  app.set("top-level-oauth-cookie", TOP_LEVEL_OAUTH_COOKIE);
  app.set("use-online-tokens", USE_ONLINE_TOKENS);
  const activeUsers = await getActiveUsers();
  activeUsers.forEach((user) => {
    ACTIVE_SHOPIFY_SHOPS[user.shopName] = user.settings;
  });
  app.set("active-shopify-shops", ACTIVE_SHOPIFY_SHOPS);

  app.use(cookieParser(Shopify.Context.API_SECRET_KEY));

  applyAuthMiddleware(app);

  app.post("/webhooks", async (req, res) => {
    try {
      await Shopify.Webhooks.Registry.process(req, res);
      console.log(`Webhook processed, returned status code 200`);
    } catch (error) {
      console.log(`Failed to process webhook: ${error}`);
      if (!res.headersSent) {
        res.status(500).send(error.message);
      }
    }
  });

  app.get("/products-count", verifyRequest(app), async (req, res) => {
    const session = await Shopify.Utils.loadCurrentSession(req, res, true);
    const { Product } = await import(
      `@shopify/shopify-api/dist/rest-resources/${Shopify.Context.API_VERSION}/index.js`
    );

    const countData = await Product.count({ session });
    res.status(200).send(countData);
  });

  app.post("/graphql", verifyRequest(app), async (req, res) => {
    try {
      const response = await Shopify.Utils.graphqlProxy(req, res);
      res.status(200).send(response.body);
    } catch (error) {
      res.status(500).send(error.message);
    }
  });

  app.use(express.json());
  mandatoryWebhookHandlers(app);

  app.use((req, res, next) => {
    const shop = req.query.shop;
    if (Shopify.Context.IS_EMBEDDED_APP && shop) {
      res.setHeader(
        "Content-Security-Policy",
        `frame-ancestors https://${shop} https://admin.shopify.com;`
      );
    } else {
      res.setHeader("Content-Security-Policy", `frame-ancestors 'none';`);
    }
    next();
  });

  app.use("/*", (req, res, next) => {
    const { shop } = req.query;

    // Detect whether we need to reinstall the app, any request from Shopify will
    // include a shop in the query parameters.
    if (app.get("active-shopify-shops")[shop] === undefined && shop) {
      res.redirect(`/auth?${new URLSearchParams(req.query).toString()}`);
    } else {
      next();
    }
  });

  /**
   * @type {import('vite').ViteDevServer}
   */
  let vite;
  if (!isProd) {
    vite = await import("vite").then(({ createServer }) =>
      createServer({
        root,
        logLevel: isTest ? "error" : "info",
        server: {
          port: PORT,
          hmr: {
            protocol: "ws",
            host: "localhost",
            port: 64999,
            clientPort: 64999,
          },
          middlewareMode: "html",
        },
      })
    );
    app.use(vite.middlewares);
  } else {
    const compression = await import("compression").then(
      ({ default: fn }) => fn
    );
    const serveStatic = await import("serve-static").then(
      ({ default: fn }) => fn
    );
    const fs = await import("fs");
    app.use(compression());
    app.use(serveStatic(resolve("dist/client")));
    app.use("/*", (req, res, next) => {
      // Client-side routing will pick up on the correct route to render, so we always render the index here
      res
        .status(200)
        .set("Content-Type", "text/html")
        .send(fs.readFileSync(`${process.cwd()}/dist/client/index.html`));
    });
  }

  return { app, vite };
}

if (!isTest) {
  createServer().then(({ app }) => app.listen(PORT));
}
