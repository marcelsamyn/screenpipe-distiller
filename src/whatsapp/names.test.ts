import { describe, expect, test } from "bun:test";
import { contactNameUpdates, groupNameUpdates } from "./names";

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
