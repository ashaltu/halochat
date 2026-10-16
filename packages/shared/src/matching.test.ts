import { describe, expect, it } from "vitest";
import { PersonCondition, Sex } from "./enums.js";
import { matchesAngelAssignment, matchingActiveAngels } from "./matching.js";

const actor = { id: "a", sex: Sex.FEMALE, dateOfBirth: "2000-01-01" };
const target = { id: "b", sex: Sex.MALE, dateOfBirth: "2000-01-01" };
const assignment = (conditions: any, status = "ACTIVE") => ({
  id: crypto.randomUUID(),
  userId: actor.id,
  angelUserId: crypto.randomUUID(),
  status,
  conditions,
});

describe("Angel matching", () => {
  it.each([
    [PersonCondition.OPPOSITE_SEX, false, true],
    [PersonCondition.STRANGER, true, true],
    [PersonCondition.STRANGER, false, false],
    [PersonCondition.ALL_CONTACTS, false, true],
  ])("evaluates %s", (condition, isStranger, expected) => {
    expect(
      matchesAngelAssignment(
        assignment({ personConditions: [condition], purposeCategories: [] }),
        actor,
        target,
        "Other",
        isStranger
      )
    ).toBe(expected);
  });

  it("combines person and purpose conditions with AND", () => {
    const scoped = assignment({
      personConditions: [PersonCondition.OPPOSITE_SEX],
      purposeCategories: ["Business inquiry"],
      combination: "AND",
    });
    expect(matchesAngelAssignment(scoped, actor, target, "Business inquiry", true)).toBe(true);
    expect(matchesAngelAssignment(scoped, actor, target, "Other", true)).toBe(false);
  });

  it("returns every independently matching active Angel", () => {
    const assignments = [
      assignment({ personConditions: [PersonCondition.OPPOSITE_SEX], purposeCategories: [] }),
      assignment({ personConditions: [], purposeCategories: ["Business inquiry"] }),
      assignment({ personConditions: [PersonCondition.ALL_CONTACTS], purposeCategories: [] }, "PENDING"),
    ];
    expect(matchingActiveAngels({ actor, target, purpose: "Business inquiry", isStranger: true, assignments })).toHaveLength(2);
  });
});
