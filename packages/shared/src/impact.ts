import { PersonCondition, ProfileCorrectionField, Sex } from "./enums.js";
import { calculateAge } from "./schemas.js";

export interface UserProfileData {
  id: string;
  username: string;
  sex: Sex;
  dateOfBirth: string;
}

export interface ActiveChatContext {
  id: string;
  partnerId: string;
  partnerSex: Sex;
  partnerDob: string;
  mode: string;
}

export interface AngelAssignmentContext {
  id: string;
  angelUserId: string;
  personConditions: PersonCondition[];
  purposeCategories: string[];
}

export interface ImpactAnalysisResult {
  userId: string;
  field: ProfileCorrectionField;
  currentValue: string;
  proposedValue: string;
  currentAge: number;
  newAge?: number;
  impactedChats: {
    chatId: string;
    partnerId: string;
    reason: string;
    angelAssignmentsAffected: string[];
  }[];
  summary: string;
}

export function computeProfileCorrectionImpact(params: {
  user: UserProfileData;
  field: ProfileCorrectionField;
  proposedValue: string;
  activeChats: ActiveChatContext[];
  angelAssignments: AngelAssignmentContext[];
}): ImpactAnalysisResult {
  const { user, field, proposedValue, activeChats, angelAssignments } = params;

  const currentAge = calculateAge(user.dateOfBirth);
  let newAge: number | undefined;
  const impactedChats: ImpactAnalysisResult["impactedChats"] = [];

  if (field === ProfileCorrectionField.DOB) {
    newAge = calculateAge(proposedValue);
    const ageCategoryChanged = (currentAge < 18 && newAge >= 18) || (currentAge >= 18 && newAge < 18);

    if (ageCategoryChanged) {
      for (const chat of activeChats) {
        impactedChats.push({
          chatId: chat.id,
          partnerId: chat.partnerId,
          reason: `Age category transitioned between minor and adult (${currentAge} -> ${newAge})`,
          angelAssignmentsAffected: [],
        });
      }
    }
  } else if (field === ProfileCorrectionField.SEX) {
    const newSex = proposedValue as Sex;

    // Check Angel assignments that protect against opposite sex
    const oppositeSexAngels = angelAssignments.filter((a) =>
      a.personConditions.includes(PersonCondition.OPPOSITE_SEX)
    );

    if (oppositeSexAngels.length > 0) {
      for (const chat of activeChats) {
        const wasOppositeSex = user.sex !== chat.partnerSex;
        const nowOppositeSex = newSex !== chat.partnerSex;

        if (wasOppositeSex !== nowOppositeSex) {
          impactedChats.push({
            chatId: chat.id,
            partnerId: chat.partnerId,
            reason: nowOppositeSex
              ? "Chat partner becomes opposite sex; opposite-sex Angel protection now triggers."
              : "Chat partner was opposite sex; opposite-sex Angel protection would no longer trigger.",
            angelAssignmentsAffected: oppositeSexAngels.map((a) => a.id),
          });
        }
      }
    }
  }

  const summary =
    impactedChats.length === 0
      ? "No active chats or Angel protection conditions are impacted by this change."
      : `${impactedChats.length} active chat(s) impacted by changes to Angel protection conditions.`;

  return {
    userId: user.id,
    field,
    currentValue: field === ProfileCorrectionField.DOB ? user.dateOfBirth : user.sex,
    proposedValue,
    currentAge,
    newAge,
    impactedChats,
    summary,
  };
}
