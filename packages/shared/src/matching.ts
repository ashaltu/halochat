import { PersonCondition, Sex } from "./enums.js";

export interface UserContext {
  id: string;
  sex: Sex | string;
  dateOfBirth: string;
}

export interface AngelAssignmentWithConditions {
  id: string;
  userId: string;
  angelUserId: string;
  status: string;
  conditions?: {
    personConditions: PersonCondition[];
    purposeCategories: string[];
    combination?: "AND" | "OR";
  } | null;
}

export interface MatchingOptions {
  actor: UserContext;
  target: UserContext;
  purpose: string;
  isStranger: boolean;
  assignments: AngelAssignmentWithConditions[];
}

/**
 * Evaluates whether an Angel assignment matches a new contact request.
 * Every independently matching Angel is included (D12).
 */
export function matchesAngelAssignment(
  assignment: AngelAssignmentWithConditions,
  actor: UserContext,
  target: UserContext,
  purpose: string,
  isStranger: boolean
): boolean {
  if (assignment.status !== "ACTIVE") {
    return false;
  }

  const conditions = assignment.conditions;
  if (!conditions) {
    return false;
  }

  const { personConditions = [], purposeCategories = [], combination = "OR" } = conditions;

  if (personConditions.length === 0 && purposeCategories.length === 0) {
    return false;
  }

  // Check person conditions
  let personMatches = false;
  if (personConditions.length > 0) {
    for (const cond of personConditions) {
      if (cond === PersonCondition.OPPOSITE_SEX && actor.sex !== target.sex) {
        personMatches = true;
        break;
      }
      if (cond === PersonCondition.STRANGER && isStranger) {
        personMatches = true;
        break;
      }
      if (cond === PersonCondition.ALL_CONTACTS) {
        personMatches = true;
        break;
      }
    }
  }

  // Check purpose category
  const purposeMatches =
    purposeCategories.length > 0 &&
    purposeCategories.some((cat) => cat.toLowerCase().trim() === purpose.toLowerCase().trim());

  if (combination === "AND" && personConditions.length > 0 && purposeCategories.length > 0) {
    return personMatches && purposeMatches;
  }

  return personMatches || purposeMatches;
}

/**
 * Returns all active Angel assignments that match the context for an actor.
 */
export function matchingActiveAngels(options: MatchingOptions): AngelAssignmentWithConditions[] {
  const { actor, target, purpose, isStranger, assignments } = options;
  return assignments.filter((assignment) =>
    matchesAngelAssignment(assignment, actor, target, purpose, isStranger)
  );
}
