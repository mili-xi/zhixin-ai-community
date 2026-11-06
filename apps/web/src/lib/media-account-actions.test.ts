import { describe, expect, it } from "vitest";
import { mediaAuthorizationArgs, mediaAccountOptionLabel, selectedMediaAccountPayload } from "./media-account-actions";

describe("independent Douyin account request boundaries", () => {
  it("adds a new account without any existing account identity", () => {
    expect(mediaAuthorizationArgs("douyin")).toEqual(["--platform", "douyin", "--wait-login-ms", "300000"]);
    expect(mediaAuthorizationArgs("douyin", "")).toEqual(mediaAuthorizationArgs("douyin"));
  });
  it("reauthorizes precisely the requested account", () => {
    expect(mediaAuthorizationArgs("douyin", "account-second")).toEqual(["--platform", "douyin", "--wait-login-ms", "300000", "--media-account-id", "account-second"]);
  });
  it("distinguishes identical nicknames and builds publication identity from selection", () => {
    const first = {id: "account-11111111", name: "同名", accountName: "同名"};
    const second = {...first, id: "account-22222222"};
    expect(mediaAccountOptionLabel(first)).not.toBe(mediaAccountOptionLabel(second));
    expect(JSON.parse(JSON.stringify({...selectedMediaAccountPayload(second.id), assetId: "asset"}))).toEqual({mediaAccountId: second.id, assetId: "asset"});
    expect(() => selectedMediaAccountPayload("")).toThrow();
  });
  it("preserves the platform authorization arguments for other platforms", () => {
    expect(mediaAuthorizationArgs("zhihu")).toEqual(["--platform", "zhihu", "--wait-login-ms", "300000"]);
  });
});
