import { describe, it, expect } from "vitest";
import { cn, formatSize } from "../../src/render/utils";

describe("formatSize", () => {
  it("0 字节显示为 0 B", () => {
    expect(formatSize(0)).toBe("0 B");
  });

  it("不足 1KB 时保留 B", () => {
    expect(formatSize(512)).toBe("512 B");
  });

  it("精确 1KB", () => {
    expect(formatSize(1024)).toBe("1 KB");
  });

  it("KB 级别保留两位小数", () => {
    expect(formatSize(1536)).toBe("1.5 KB");
  });

  it("MB 级别", () => {
    expect(formatSize(1024 * 1024)).toBe("1 MB");
    expect(formatSize(5.5 * 1024 * 1024)).toBe("5.5 MB");
  });

  it("GB 级别", () => {
    expect(formatSize(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });

  it("TB 级别", () => {
    expect(formatSize(2 * 1024 ** 4)).toBe("2 TB");
  });
});

describe("cn", () => {
  it("合并多个类名", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("tailwind 冲突类以后者为胜", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("bg-red-500", "bg-blue-500")).toBe("bg-blue-500");
  });

  it("忽略 falsy 值", () => {
    expect(cn("a", false, null, undefined, "", "b")).toBe("a b");
  });

  it("无参数返回空字符串", () => {
    expect(cn()).toBe("");
  });
});
