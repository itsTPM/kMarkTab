import { Blob as NodeBlob } from "node:buffer";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteImageFile,
  loadImageFile,
  saveImageFile,
} from "../entrypoints/newtab/core/image-file";

// fake-indexeddb stores structured clones, and Node can clone only its own Blob;
// happy-dom's comes back as a plain object
const blob = (text: string) => new NodeBlob([text]) as Blob;

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});

describe("image file storage", () => {
  it("has nothing stored at first", async () => {
    expect(await loadImageFile()).toBeUndefined();
  });

  it("stores, replaces and deletes the file", async () => {
    await saveImageFile(blob("one"));
    await saveImageFile(blob("two"));
    expect(await (await loadImageFile())?.text()).toBe("two");
    await deleteImageFile();
    expect(await loadImageFile()).toBeUndefined();
  });
});
