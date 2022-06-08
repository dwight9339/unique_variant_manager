import { 
  Form,
  FormLayout,
  TextField,
  DropZone,
  Spinner,
  Thumbnail,
  Button
} from "@shopify/polaris";
import { useState, useContext } from "react";
import { useImageUpload } from "../../utils/hooks/useImageUpload";
import { upsertProduct } from "../../utils/apiHooks/upsertProduct";
import { getIdFromGid } from "../../utils/gidHelper";
import { useNavigate, useOutletContext } from "react-router-dom";
import { FeedbackContext } from "../../app/AppFrame";

export const ProductForm = () => {
  const upsertProductHook = upsertProduct();
  const navigate = useNavigate();
  const { showBanner, showToast } = useContext(FeedbackContext);
  const { product } = useOutletContext();
  const { imageSrc, imageLoading, component: imageDropZone } = useImageUpload(product);
  const processType = product ? "Update" : "Create";

  const [productTitle, setProductTitle] = useState(product?.title);
  const [productDescription, setProductDescription] = useState(product?.description);
  const [productType, setProductType] = useState(product?.productType);
  const [productTags, setProductTags] = useState(product?.tags?.join());
  const [processing, setProcessing] = useState(false);

  const getImageData = () => {
    if (!imageSrc) return null;

    return {
      src: imageSrc,
      altText: `Image of ${productTitle}`,
      id: product?.featuredImage?.id
    };
  }

  const handleSubmit = async () => {
    const productInput = {
      productTitle,
      productDescription,
      productType,
      productTags,
      imageData: getImageData(),
      prevProduct: product
    };

    try {
      setProcessing(true);
      const results = await upsertProductHook(productInput);
      const productId = getIdFromGid(results.id);
      navigate(`/product/${productId}`, {state: {reload: Boolean(product)}});
      showToast(`${`${processType}d`} ${results.title}`);
    } catch(err) {
      const typeSafeError = Array.isArray(err) || typeof(err) === "string";
      showBanner(`${processType} error`, (typeSafeError && err) || err.message || "", "critical");
      console.error(err);
    } finally {
      setProcessing(false);
    }
  }

  return (
    <Form
      onSubmit={handleSubmit}
    >
      <FormLayout>
        <FormLayout.Group>
          <TextField 
            type="text"
            label="Title"
            value={productTitle}
            onChange={setProductTitle}
            autoComplete="off"
          />
        </FormLayout.Group>
        <FormLayout.Group>
          <TextField 
            type="text"
            label="Description"
            value={productDescription}
            onChange={setProductDescription}
            multiline
            autoComplete="off"
          />
        </FormLayout.Group>
        <FormLayout.Group>
          <TextField 
            type="text"
            label="Type"
            value={productType}
            onChange={setProductType}
            autoComplete="off"
          />
          <TextField 
            type="text"
            label="Tags (Comma-separated)"
            value={productTags}
            onChange={setProductTags}
            autoComplete="off"
          />
        </FormLayout.Group>
        <FormLayout.Group>
          {imageDropZone}
        </FormLayout.Group>
        <Button
          primary
          submit
          loading={processing || imageLoading}
          disabled={!productTitle}
        >
          {product ? "Update" : "Create"}
        </Button>
      </FormLayout>
    </Form>
  )
}