function unsupportedAdapterError(platform, operation) {
  const error = new Error(`Platform adapter '${platform || "unknown"}' does not implement ${operation}.`);
  error.code = "PLATFORM_ADAPTER_NOT_IMPLEMENTED";
  error.platform = platform || "";
  error.operation = operation;
  return error;
}

export class MediaPlatformAdapter {
  constructor(platform, loginUrl, fieldNames, accountLabel) {
    this.platform = platform;
    this.loginUrl = loginUrl;
    this.fieldNames = fieldNames;
    this.accountLabel = accountLabel || `${platform} account`;
  }

  async detectLoggedIn() {
    throw unsupportedAdapterError(this.platform, "login detection");
  }

  async readAccountProfile() {
    throw unsupportedAdapterError(this.platform, "account profile discovery");
  }

  async collectAuthArtifact() {
    throw unsupportedAdapterError(this.platform, "credential collection");
  }

  async publishArticle() {
    throw unsupportedAdapterError(this.platform, "article publishing");
  }
}