import { describe, expect, test } from "bun:test";
import { sanitizeForVectorization } from "./content-sanitizer";

describe("sanitizeForVectorization", () => {
  test("preserves text inside common HTML formatting wrappers", () => {
    expect(sanitizeForVectorization('Before <font color="#ff0000">hidden text</font> after')).toBe(
      "Before hidden text after",
    );
    expect(sanitizeForVectorization("<p>First paragraph.</p><p>Second paragraph.</p>")).toBe(
      "First paragraph.\n\nSecond paragraph.",
    );
  });

  test("removes details blocks and reasoning while keeping surrounding content", () => {
    expect(sanitizeForVectorization("Visible <details>private note</details> still visible")).toBe("Visible still visible");
    expect(sanitizeForVectorization("A<details>private note</details>B")).toBe("A B");
    expect(sanitizeForVectorization("Answer <think>chain of thought</think> done")).toBe("Answer done");
  });

  test("strips unknown XML-like wrappers without dropping their content", () => {
    expect(sanitizeForVectorization("A <custom-tag attr=\"x\">wrapped fact</custom-tag> B")).toBe(
      "A wrapped fact B",
    );
  });
});
