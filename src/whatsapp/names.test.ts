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
      { jid: "a@s.whatsapp.net", name: "Alice", isGroup: false },
      { jid: "b@s.whatsapp.net", name: "Bob", isGroup: false },
      { jid: "c@s.whatsapp.net", name: "Carol Inc", isGroup: false },
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
      { jid: "trip@g.us", name: "Trip 2026", isGroup: true },
      { jid: "fam@g.us", name: "Family", isGroup: true },
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
      { jid: "a@s.whatsapp.net", name: "Alice", isGroup: false },
      { jid: "alice@s.whatsapp.net", name: "Alice in Trip group", isGroup: false },
    ]);
  });
});
