import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
afterEach(() => vi.unstubAllGlobals());
describe("video upload streaming proxy", () => {
  it("forwards the exact stream and authentication without buffering", async () => {
    const stream = new ReadableStream({start(controller) {controller.enqueue(new Uint8Array([1,2,3]));controller.close();}});
    const request = new Request("http://localhost/api/video-assets/upload", {method:"POST",body:stream,duplex:"half",headers:{"content-type":"multipart/form-data; boundary=test","cookie":"zhixin_session=test"}} as RequestInit);
    const upstream = vi.fn(async (_url, init) => {expect(init.body).toBe(request.body);expect(init.duplex).toBe("half");expect(init.credentials).toBe("omit");expect(init.headers.get("cookie")).toBe("zhixin_session=test");return new Response('{"id":"uploaded"}',{status:200,headers:{"content-type":"application/json"}});});
    vi.stubGlobal("fetch",upstream);
    expect(await (await POST(request)).json()).toEqual({id:"uploaded"});
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("rejects oversize requests before connecting upstream", async () => {
    const upstream=vi.fn();vi.stubGlobal("fetch",upstream);
    const response=await POST(new Request("http://localhost/api/video-assets/upload",{method:"POST",headers:{"content-length":String(503*1024*1024)}}));
    expect(response.status).toBe(413);expect(upstream).not.toHaveBeenCalled();
  });
});
