import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { readFileFromTool } from "./workspace-file-tools.js";

const workspace = {
  botId: "bot",
  computerMode: "personal",
  nativeHost: true,
  acceptsImages: true,
  computer: async () => ({ id: "host" }),
  context: {},
  runSecrets: [],
  markDirty: () => {},
} as any;

describe("headless file image inspection", () => {
  it("returns actual resized image pixels through the native file boundary", async () => {
    const png = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const readFile = vi.fn(async (..._args: unknown[]) => png);
    const result: any = await readFileFromTool({ readFile } as any, workspace, {
      path: "/private/slide.png",
    });
    expect(readFile.mock.calls[0]?.[1]).toBe("/private/slide.png");
    expect(result.kind).toBe("agent_tool_result");
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    const metadata = await sharp(Buffer.from(result.content[1].data, "base64")).metadata();
    expect([metadata.width, metadata.height]).toEqual([1600, 800]);
  });
  it("does not read an image when the model cannot see", async () => {
    const readFile = vi.fn();
    expect(
      await readFileFromTool(
        { readFile } as any,
        { ...workspace, acceptsImages: false },
        { path: "slide.jpg" },
      ),
    ).toMatchObject({ error: expect.stringContaining("cannot see") });
    expect(readFile).not.toHaveBeenCalled();
  });
  it("rejects corrupt and oversized image data, preserves text behavior", async () => {
    expect(
      await readFileFromTool({ readFile: async () => Buffer.from("bad") } as any, workspace, {
        path: "bad.jpg",
      }),
    ).toHaveProperty("error");
    expect(
      await readFileFromTool(
        { readFile: async () => new Uint8Array(20_000_001) } as any,
        workspace,
        { path: "big.jpg" },
      ),
    ).toMatchObject({ error: "image exceeds 20000000 bytes" });
    expect(
      await readFileFromTool({ readFile: async () => Buffer.from("hello") } as any, workspace, {
        path: "note.txt",
      }),
    ).toEqual({ path: "note.txt", content: "hello" });
  });
});
