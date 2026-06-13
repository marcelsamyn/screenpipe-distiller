import { describe, expect, test } from "bun:test";
import { contactNameUpdates, groupNameUpdates, pushNameUpdates } from "./names";

describe("contactNameUpdates", () => {
  test("prefers name, then notify, then verifiedName; skips blanks and id-less", () => {
    expect(
      contactNameUpdates([
        { id: "a@s.whatsapp.net", name: "Alice" },
        { id: "b@s.whatsapp.net", notify: "Bob" },
        { id: "c@s.whatsapp.net", verifiedName: "Carol Inc" },
        { id: "d@s.whatsapp.net", name: "  ", notify: "" },
        { name: "No Id" },
      ]),
    ).toEqual([
      { jid: "a@s.whatsapp.net", name: "Alice", isGroup: false, saved: true },
      { jid: "b@s.whatsapp.net", name: "Bob", isGroup: false, saved: false },
      { jid: "c@s.whatsapp.net", name: "Carol Inc", isGroup: false, saved: false },
    ]);
  });

  test("keys a saved contact under both its lid and phone-number jids", () => {
    expect(
      contactNameUpdates([
        { id: "111@lid", lid: "111@lid", phoneNumber: "31600000000@s.whatsapp.net", name: "Dana" },
      ]),
    ).toEqual([
      { jid: "111@lid", name: "Dana", isGroup: false, saved: true },
      { jid: "31600000000@s.whatsapp.net", name: "Dana", isGroup: false, saved: true },
    ]);
  });
});

describe("groupNameUpdates", () => {
  test("keeps group jids with a name/subject; drops non-groups and blanks", () => {
    expect(
      groupNameUpdates([
        { id: "trip@g.us", subject: "Trip 2026" },
        { id: "fam@g.us", name: "Family" },
        { id: "person@s.whatsapp.net", name: "Not A Group" },
        { id: "empty@g.us", subject: "  " },
      ]),
    ).toEqual([
      { jid: "trip@g.us", name: "Trip 2026", isGroup: true, saved: false },
      { jid: "fam@g.us", name: "Family", isGroup: true, saved: false },
    ]);
  });
});

describe("pushNameUpdates", () => {
  test("takes inbound pushName as a contact name; skips fromMe and blanks", () => {
    expect(
      pushNameUpdates([
        { sender: "a@s.whatsapp.net", fromMe: false, pushName: "Alice" },
        { sender: "alice@s.whatsapp.net", fromMe: false, pushName: "Alice in Trip group" }, // group participant
        { sender: "me", fromMe: true, pushName: "My Phone" },
        { sender: "b@s.whatsapp.net", fromMe: false, pushName: null },
        { sender: "c@s.whatsapp.net", fromMe: false, pushName: "  " },
      ]),
    ).toEqual([
      { jid: "a@s.whatsapp.net", name: "Alice", isGroup: false, saved: false },
      { jid: "alice@s.whatsapp.net", name: "Alice in Trip group", isGroup: false, saved: false },
    ]);
  });
});
