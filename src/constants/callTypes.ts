import type { CallType } from '@/types/debrief';

/** The kinds of call Psst can debrief, and the copy for each. */
export interface CallTypeDefinition {
  id: CallType;
  label: string;
  blurb: string;
}

export const CALL_TYPES: CallTypeDefinition[] = [
  { id: 'sales', label: 'Sales', blurb: 'Pipeline calls, demos, quotes.' },
  { id: 'customer', label: 'Customer', blurb: 'Renewals, support, success.' },
  { id: 'negotiation', label: 'Negotiation', blurb: 'Salary, terms, pricing.' },
  { id: 'meeting', label: 'Meeting', blurb: 'Team and stakeholder calls.' },
  { id: 'difficult', label: 'Difficult', blurb: 'Feedback, conflict, bad news.' },
  { id: 'other', label: 'Other', blurb: 'Anything worth remembering.' },
];

export const DEFAULT_CALL_TYPE: CallType = 'other';

const OTHER = CALL_TYPES[CALL_TYPES.length - 1];

export function isCallType(value: unknown): value is CallType {
  return typeof value === 'string' && CALL_TYPES.some((callType) => callType.id === value);
}

export function getCallType(id: CallType): CallTypeDefinition {
  return CALL_TYPES.find((callType) => callType.id === id) ?? OTHER;
}
