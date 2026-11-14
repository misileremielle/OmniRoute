/**
 * Body for POST /api/providers/validate, shared by the add and edit connection modals
 * (their "Check" button and their save-time re-validation sent the same object four times).
 */
type ValidateFormFields = {
  validationModelId?: string;
  customUserAgent: string;
  baseUrl: string;
  region: string;
  awsAccessKeyId: string;
  awsSessionToken: string;
  cx: string;
  accountId?: string;
};

const trimmedOrUndefined = (value: string) => value.trim() || undefined;

function validateRegion(
  formData: ValidateFormFields,
  isAwsPolly: boolean,
  showsRegion: boolean,
  defaultRegion: string
): string | undefined {
  if (isAwsPolly) return formData.region.trim() || "us-east-1";
  return showsRegion ? formData.region.trim() || defaultRegion : undefined;
}

/** Fields that only apply to one provider family; undefined otherwise. */
function familyFields(formData: ValidateFormFields, isAwsPolly: boolean) {
  return {
    accessKeyId: isAwsPolly ? trimmedOrUndefined(formData.awsAccessKeyId) : undefined,
    sessionToken: isAwsPolly ? trimmedOrUndefined(formData.awsSessionToken) : undefined,
  };
}

export function buildProviderValidateRequestBody(options: {
  provider: string;
  apiKey: string;
  formData: ValidateFormFields;
  isAwsPolly: boolean;
  showsRegion: boolean;
  defaultRegion: string;
}) {
  const { provider, apiKey, formData, isAwsPolly, showsRegion, defaultRegion } = options;
  const family = familyFields(formData, isAwsPolly);
  return {
    provider,
    apiKey,
    validationModelId: formData.validationModelId || undefined,
    customUserAgent: trimmedOrUndefined(formData.customUserAgent),
    baseUrl: trimmedOrUndefined(formData.baseUrl),
    region: validateRegion(formData, isAwsPolly, showsRegion, defaultRegion),
    accessKeyId: family.accessKeyId,
    sessionToken: family.sessionToken,
    cx: trimmedOrUndefined(formData.cx),
    accountId: formData.accountId ? trimmedOrUndefined(formData.accountId) : undefined,
  };
}
