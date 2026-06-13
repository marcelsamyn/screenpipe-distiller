import { describe, expect, test } from "bun:test";
import { classifyChannel, isCommunicationApp } from "./channels";

describe("classifyChannel", () => {
  test("WhatsApp Web by URL → WhatsApp (web) comms bucket", () => {
    expect(
      classifyChannel({ app_name: "Google Chrome", browser_url: "https://web.whatsapp.com/" }),
    ).toEqual({ bucketKey: "WhatsApp (web)", isComms: true });
  });

  test("WhatsApp Web by title only (no browser_url) → WhatsApp (web) comms bucket", () => {
    expect(
      classifyChannel({ app_name: "Google Chrome", window_title: "WhatsApp — 3 unread" }),
    ).toEqual({ bucketKey: "WhatsApp (web)", isComms: true });
  });

  test("title match in a non-browser app stays generic", () => {
    expect(
      classifyChannel({ app_name: "Zed", window_title: "whatsapp.ts — screenpipe-distiller" }),
    ).toEqual({ bucketKey: "Zed", isComms: false });
  });

  test("native WhatsApp desktop app keeps its own name (not the web label)", () => {
    expect(classifyChannel({ app_name: "WhatsApp" })).toEqual({ bucketKey: "WhatsApp", isComms: true });
  });

  test("generic Chrome tab is not comms", () => {
    expect(
      classifyChannel({ app_name: "Google Chrome", browser_url: "https://github.com/foo/bar" }),
    ).toEqual({ bucketKey: "Google Chrome", isComms: false });
  });

  test("Gmail by URL → Gmail comms bucket", () => {
    expect(
      classifyChannel({ app_name: "Google Chrome", browser_url: "https://mail.google.com/mail/u/0/" }),
    ).toEqual({ bucketKey: "Gmail", isComms: true });
  });

  test("missing app_name falls back to Unknown, not comms", () => {
    expect(classifyChannel({})).toEqual({ bucketKey: "Unknown", isComms: false });
  });

  test("WhatsApp Web by window_name alone → WhatsApp (web) comms bucket", () => {
    expect(
      classifyChannel({ app_name: "Google Chrome", window_name: "WhatsApp" }),
    ).toEqual({ bucketKey: "WhatsApp (web)", isComms: true });
  });

  test("empty app_name falls back to Unknown, not comms", () => {
    expect(classifyChannel({ app_name: "   " })).toEqual({ bucketKey: "Unknown", isComms: false });
  });

  test("isCommunicationApp still recognizes native Slack", () => {
    expect(isCommunicationApp("Slack")).toBe(true);
    expect(isCommunicationApp("Zed")).toBe(false);
  });
});
