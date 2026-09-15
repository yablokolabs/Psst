import type { ConversationPreset } from '@/types/conversation';

export interface PresetDefinition {
  id: ConversationPreset;
  label: string;
  blurb: string;
  titlePlaceholder: string;
  objectivePlaceholder: string;
}

export const PRESETS: PresetDefinition[] = [
  {
    id: 'negotiation',
    label: 'Negotiation',
    blurb: 'Salary, commercial terms, renewals.',
    titlePlaceholder: 'Compensation package',
    objectivePlaceholder: 'Agree a package that reflects the scope of the role.',
  },
  {
    id: 'sales',
    label: 'Sales',
    blurb: 'Pipeline calls and demos.',
    titlePlaceholder: 'Sales call with Acme',
    objectivePlaceholder: 'Understand their budget before offering any discount.',
  },
  {
    id: 'customer',
    label: 'Customer',
    blurb: 'Renewals, escalations, success.',
    titlePlaceholder: 'Customer renewal discussion',
    objectivePlaceholder: 'Confirm renewal terms and grow the account.',
  },
  {
    id: 'meeting',
    label: 'Meeting',
    blurb: 'Team and stakeholder meetings.',
    titlePlaceholder: 'Launch readiness meeting',
    objectivePlaceholder: 'Leave with owners and dates for every open item.',
  },
  {
    id: 'difficult',
    label: 'Difficult conversation',
    blurb: 'Feedback, conflict, bad news.',
    titlePlaceholder: 'Customer escalation',
    objectivePlaceholder: 'Acknowledge the impact and agree a way forward.',
  },
  {
    id: 'other',
    label: 'Other',
    blurb: 'Anything else you want a second pair of ears for.',
    titlePlaceholder: 'Conversation',
    objectivePlaceholder: 'What would make this conversation a success?',
  },
];

export const DEFAULT_PRESET: ConversationPreset = 'negotiation';

export const OTHER_PRESET = PRESETS[PRESETS.length - 1];

export function getPreset(id: ConversationPreset): PresetDefinition {
  return PRESETS.find((preset) => preset.id === id) ?? OTHER_PRESET;
}
