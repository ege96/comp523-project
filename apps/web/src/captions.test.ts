import { describe, expect, it } from "vitest";

import { englishText, formatVttTime, toVtt } from "./captions";

describe("captions", () => {
  it("formats WebVTT times as HH:MM:SS.mmm", () => {
    expect(formatVttTime(0)).toBe("00:00:00.000");
    expect(formatVttTime(754_005)).toBe("00:12:34.005");
    expect(formatVttTime(3_723_450)).toBe("01:02:03.450");
    expect(formatVttTime(-5)).toBe("00:00:00.000");
  });

  it("takes the translation, else an original that is itself English", () => {
    const line = { original_text: "Namaste", english_text: null, language: "ne" };
    expect(englishText(line)).toBeNull();
    expect(englishText({ ...line, english_text: "Hello" })).toBe("Hello");
    expect(englishText({ ...line, original_text: "Hello", language: "en" })).toBe("Hello");
    expect(englishText({ ...line, original_text: "Hello", language: "en-GB" })).toBe("Hello");
    expect(englishText({ ...line, language: null })).toBeNull();
  });

  it("builds a caption file, escaping what would break a cue", () => {
    expect(
      toVtt([
        { start_ms: 0, end_ms: 1500, text: "A --> B & <i>" },
        { start_ms: 1500, end_ms: 1500, text: "no length" },
        { start_ms: 2000, end_ms: 3000, text: "   " },
        { start_ms: 3000, end_ms: 4000, text: "one\n\ntwo" },
      ]),
    ).toBe(
      "WEBVTT\n\n" +
        "00:00:00.000 --> 00:00:01.500\nA --&gt; B &amp; &lt;i&gt;\n\n" +
        "00:00:03.000 --> 00:00:04.000\none\ntwo\n",
    );
    expect(toVtt([])).toBe("WEBVTT\n");
  });
});
