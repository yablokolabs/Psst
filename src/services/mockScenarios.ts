/**
 * Scripted demo conversations, one per preset.
 *
 * Phase 1 content only: these are the realistic mock events the LIVE screen
 * replays. Nothing here is sent anywhere. When the ElevenLabs pipeline lands,
 * this file stays as the offline/demo fixture (and as seed data for history).
 */

import type { CueTone, Speaker } from '@/types/conversation';

export interface ScenarioLine {
  /** Milliseconds after the session starts. */
  at: number;
  speaker: Speaker;
  text: string;
}

export interface ScenarioCue {
  at: number;
  tone: CueTone;
  observation: string;
  action: string;
}

export interface ScenarioRecap {
  summary: string;
  keyPoints: string[];
  commitments: string[];
  missed: string[];
  nextActions: string[];
}

export interface MockScenario {
  preset: string;
  sampleTitle: string;
  sampleObjective: string;
  /** How long the mock conversation runs before it ends on its own. */
  durationMs: number;
  lines: ScenarioLine[];
  cues: ScenarioCue[];
  recap: ScenarioRecap;
}

const sales: MockScenario = {
  preset: 'sales',
  sampleTitle: 'Sales call with Acme',
  sampleObjective: 'Understand their budget before offering any discount.',
  durationMs: 54000,
  lines: [
    { at: 2000, speaker: 'them', text: "We've reviewed the proposal and overall we really like it." },
    { at: 5000, speaker: 'them', text: 'The main concern is the $2,000 monthly price.' },
    {
      at: 11000,
      speaker: 'you',
      text: 'Totally fair. Before we talk numbers, what budget range did you have in mind?',
    },
    {
      at: 16000,
      speaker: 'them',
      text: "We'd pencilled in around $1,400 a month, but that was before we saw the analytics piece.",
    },
    {
      at: 23000,
      speaker: 'them',
      text: 'If the analytics module solved the reporting gap we could probably get closer.',
    },
    {
      at: 31000,
      speaker: 'them',
      text: 'Reporting is the pain. We spend two days a month on it by hand.',
    },
    {
      at: 40000,
      speaker: 'you',
      text: "Let's scope the analytics pilot at $2,000 for 60 days. If it removes those two days, we move to annual.",
    },
    { at: 46000, speaker: 'them', text: "That works. Send it over and I'll get it signed this week." },
  ],
  cues: [
    {
      at: 7000,
      tone: 'question',
      observation: 'Price may not be the real blocker.',
      action: 'Ask what budget range they expected.',
    },
    {
      at: 18000,
      tone: 'opportunity',
      observation: 'They have a number and a reason to move.',
      action: 'Anchor on the analytics module, not on price.',
    },
    {
      at: 26000,
      tone: 'signal',
      observation: '"Probably get closer" is a buying signal.',
      action: 'Ask which report they want to stop doing by hand.',
    },
    {
      at: 34000,
      tone: 'opportunity',
      observation: 'Two days a month is quantifiable pain.',
      action: 'Trade the pilot for value — do not discount.',
    },
    {
      at: 49000,
      tone: 'signal',
      observation: 'They committed. Lock the next step.',
      action: 'Confirm who signs and by which date.',
    },
  ],
  recap: {
    summary:
      'Acme likes the product but raised the $2,000 monthly price as their main concern. Their real constraint turned out to be reporting effort, not budget.',
    keyPoints: [
      'Product fit is positive — they opened with "we really like it"',
      'Price was the stated objection, reporting was the actual one',
      'Budget expectation was about $1,400 a month before the analytics module',
      'They spend two days a month on manual reporting',
    ],
    commitments: [
      'You agreed to scope an analytics pilot at $2,000 for 60 days',
      'They agreed to sign this week if the pilot covers reporting',
    ],
    missed: [
      'Nobody confirmed who signs the agreement',
      'No date was set for the pilot start',
      'Annual expansion was mentioned by you but never confirmed by them',
    ],
    nextActions: [
      'Send the pilot scope with the reporting-to-analytics mapping',
      'Ask for the signer name and the signature date',
      'Book the 60-day review before the pilot starts',
    ],
  },
};

const negotiation: MockScenario = {
  preset: 'negotiation',
  sampleTitle: 'Salary negotiation',
  sampleObjective: 'Agree a package that reflects the scope of the role.',
  durationMs: 52000,
  lines: [
    { at: 2500, speaker: 'them', text: "We can offer £85,000 and we'd love to have you join." },
    {
      at: 9000,
      speaker: 'you',
      text: "Thanks — that's close to where I want to be. Is there flexibility on a joining bonus?",
    },
    { at: 14000, speaker: 'them', text: "There's usually some room there. What were you thinking?" },
    { at: 21000, speaker: 'them', text: "I'd need to check with finance on anything above £5,000." },
    { at: 28000, speaker: 'you', text: 'Understood. What can you approve without going to finance?' },
    { at: 33000, speaker: 'them', text: 'Up to £8,000 for the right candidate.' },
    { at: 40000, speaker: 'them', text: 'I can get that in the offer letter this afternoon.' },
  ],
  cues: [
    {
      at: 5500,
      tone: 'opportunity',
      observation: "Joining bonus hasn't been discussed.",
      action: 'Ask whether one is available before finalising.',
    },
    {
      at: 16000,
      tone: 'opportunity',
      observation: 'They have room and they just said so.',
      action: 'Name a number tied to the scope you are taking on.',
    },
    {
      at: 23000,
      tone: 'question',
      observation: 'Do not counter blind — find their ceiling.',
      action: 'Ask what you can approve without escalation.',
    },
    {
      at: 35000,
      tone: 'signal',
      observation: '£8,000 sits inside their approved range.',
      action: 'Ask for it in the offer letter today.',
    },
    {
      at: 43000,
      tone: 'risk',
      observation: 'Base and bonus are settled, the rest is not.',
      action: 'Confirm title and review date in the same letter.',
    },
  ],
  recap: {
    summary:
      'The base offer was £85,000 with an unrequested joining bonus available. Asking about the bonus moved the conversation from base pay to total package.',
    keyPoints: [
      'Base offer: £85,000, described as close to your target',
      'A joining bonus had not been raised by either side',
      'Approval ceiling without finance was £8,000',
      'The offer letter can be issued the same day',
    ],
    commitments: [
      'They will put an £8,000 joining bonus in the offer letter today',
    ],
    missed: [
      'Review date and title were never agreed',
      'Equity and pension were not discussed at all',
      'No deadline was set for accepting the offer',
    ],
    nextActions: [
      'Read the offer letter and check bonus wording, title and review date',
      'Ask for the first review date in writing',
      'Confirm the acceptance deadline before the weekend',
    ],
  },
};

const customer: MockScenario = {
  preset: 'customer',
  sampleTitle: 'Customer renewal discussion',
  sampleObjective: 'Confirm renewal terms and grow the account.',
  durationMs: 50000,
  lines: [
    { at: 2000, speaker: 'them', text: "The team's happy with the platform, we just need to talk about renewal." },
    { at: 9000, speaker: 'them', text: "We've doubled the team so seat count is the issue." },
    { at: 16000, speaker: 'them', text: 'Probably 40 by Q3, up from 22 today.' },
    { at: 24000, speaker: 'them', text: 'Our finance team will want a single number though.' },
    {
      at: 31000,
      speaker: 'you',
      text: 'I can hold an annual price for 40 seats and lock it for 12 months.',
    },
    { at: 36000, speaker: 'them', text: "That's easier to approve. Send the annual version." },
  ],
  cues: [
    {
      at: 4000,
      tone: 'signal',
      observation: 'Renewal is a buying signal, not a negotiation yet.',
      action: 'Ask what changed for them this year.',
    },
    {
      at: 11000,
      tone: 'question',
      observation: 'Growth is the story here.',
      action: 'Ask how many seats they expect by next quarter.',
    },
    {
      at: 18000,
      tone: 'opportunity',
      observation: '22 to 40 seats earns volume tiers.',
      action: 'Offer a tier instead of a headline discount.',
    },
    {
      at: 26000,
      tone: 'risk',
      observation: 'They need certainty, not complexity.',
      action: 'Quote annually so the monthly price stops being the topic.',
    },
    {
      at: 39000,
      tone: 'signal',
      observation: 'Approval is the last blocker.',
      action: 'Ask who signs and what they need to see.',
    },
  ],
  recap: {
    summary:
      'A healthy renewal conversation: satisfaction is high, seat count is growing from 22 to 40 and finance needs one annual figure rather than a per-seat breakdown.',
    keyPoints: [
      'The team is happy with the platform',
      'Seat count is expected to reach 40 by Q3, up from 22',
      'Finance wants a single annual number to approve',
      'You offered a 12-month locked price for 40 seats',
    ],
    commitments: [
      'You will send the annual version of the renewal',
      'You will hold the price for 12 months at 40 seats',
    ],
    missed: [
      'The approver was never named',
      'The renewal calendar date was not confirmed',
      'No expansion conversation was started for other teams',
    ],
    nextActions: [
      'Send the annual renewal quote with the locked seat price',
      'Ask who signs and what they need alongside the quote',
      'Diarise the renewal date and the Q3 seat review',
    ],
  },
};

const meeting: MockScenario = {
  preset: 'meeting',
  sampleTitle: 'Launch readiness meeting',
  sampleObjective: 'Leave with owners and dates for every open item.',
  durationMs: 46000,
  lines: [
    { at: 2000, speaker: 'them', text: 'Before we start — the launch date is the thing that worries me.' },
    { at: 10000, speaker: 'them', text: "Honestly, testing is the risk. We haven't allocated anyone." },
    { at: 17000, speaker: 'them', text: "That would be Priya, but she's on the migration until the 12th." },
    { at: 25000, speaker: 'them', text: "Let's say the 15th for the testing handover." },
    { at: 33000, speaker: 'them', text: "Right, that's agreed then." },
  ],
  cues: [
    {
      at: 4500,
      tone: 'question',
      observation: 'The date is the real agenda.',
      action: 'Ask what has to be true for that date to hold.',
    },
    {
      at: 12000,
      tone: 'risk',
      observation: 'Unnamed owners sink dates.',
      action: 'Ask for a name against testing today.',
    },
    {
      at: 19000,
      tone: 'signal',
      observation: 'Soft commitment with a schedule conflict.',
      action: 'Agree a date after the 12th instead of assuming.',
    },
    {
      at: 27000,
      tone: 'opportunity',
      observation: 'A decision was made out loud.',
      action: 'Repeat the date, owner and dependency back to them.',
    },
    {
      at: 35000,
      tone: 'signal',
      observation: 'Agreement without a next step is a maybe.',
      action: 'Ask what each of you sends by Friday.',
    },
  ],
  recap: {
    summary:
      'The launch date is at risk because nobody owns testing. Priya is the natural owner but is unavailable until the 12th, so the handover moved to the 15th.',
    keyPoints: [
      'The launch date is the meeting\'s real concern',
      'Testing had no named owner at the start of the meeting',
      'Priya is on the migration until the 12th',
      'Testing handover agreed for the 15th',
    ],
    commitments: [
      'Testing handover moves to the 15th',
      'Priya takes testing once the migration finishes',
    ],
    missed: [
      'No one confirmed what "launch ready" means in writing',
      'Design sign-off was never given a date',
      'Nobody agreed what would be cut if the 15th slips',
    ],
    nextActions: [
      'Confirm the 15th with Priya directly and note the dependency',
      'Write down the launch-readiness checklist and share it',
      'Agree the fallback scope in case the migration overruns',
    ],
  },
};

const difficult: MockScenario = {
  preset: 'difficult',
  sampleTitle: 'Customer escalation',
  sampleObjective: 'Acknowledge the impact and agree a way forward.',
  durationMs: 48000,
  lines: [
    { at: 2500, speaker: 'them', text: "I'll be honest, I don't think the last release was handled well." },
    {
      at: 10000,
      speaker: 'you',
      text: "That's fair — the delay cost you the trade show window, and that's on us.",
    },
    { at: 14000, speaker: 'them', text: 'It did. We had to refund customers.' },
    { at: 22000, speaker: 'them', text: "I'd want a written plan so it doesn't happen again." },
    { at: 29000, speaker: 'them', text: "If you can do that by Thursday, we're fine." },
    { at: 37000, speaker: 'you', text: 'The plan lands Thursday. Does that close this out?' },
    { at: 41000, speaker: 'them', text: "Yes — send it Thursday and we'll move on." },
  ],
  cues: [
    {
      at: 5000,
      tone: 'risk',
      observation: 'They want to be heard before they want a fix.',
      action: 'Acknowledge the impact before defending anything.',
    },
    {
      at: 16000,
      tone: 'question',
      observation: 'They just named the real cost.',
      action: 'Ask what would make this right for them.',
    },
    {
      at: 24000,
      tone: 'opportunity',
      observation: 'They asked for process, not money.',
      action: 'Offer a dated plan with owners this week.',
    },
    {
      at: 31000,
      tone: 'risk',
      observation: '"Fine" is not the same as resolved.',
      action: 'Ask whether the account is safe once the plan lands.',
    },
    {
      at: 43000,
      tone: 'signal',
      observation: 'They gave you a clear close.',
      action: 'Send the plan Thursday and confirm receipt.',
    },
  ],
  recap: {
    summary:
      'A tense escalation that ended constructively. The customer wanted a written plan for preventing a repeat of the delayed release, not compensation.',
    keyPoints: [
      'The release delay cost them their trade show window',
      'They refunded customers as a result',
      'They asked for a written prevention plan rather than credits',
      'Thursday was accepted as the delivery date',
    ],
    commitments: [
      'A written prevention plan will be sent by Thursday',
      'The account continues once the plan lands',
    ],
    missed: [
      'No internal owner was named for the prevention plan',
      'The refund cost was never quantified',
      'No follow-up check-in was scheduled after Thursday',
    ],
    nextActions: [
      'Write the plan with named owners and dates, and send it Thursday',
      'Ask for written confirmation that the account is settled',
      'Schedule a 30-day check-in to prove the change worked',
    ],
  },
};

const other: MockScenario = {
  preset: 'other',
  sampleTitle: 'Partner discussion',
  sampleObjective: 'Understand who decides and when.',
  durationMs: 44000,
  lines: [
    { at: 2500, speaker: 'them', text: 'So the short version is we need a decision by the end of the month.' },
    { at: 10000, speaker: 'them', text: "We'd lose the budget line for this year." },
    {
      at: 17000,
      speaker: 'them',
      text: 'Probably the middle option, but the team prefers the bigger one.',
    },
    { at: 25000, speaker: 'them', text: "My director, and she's back next Monday." },
    { at: 32000, speaker: 'them', text: "That would help — send it today and I'll forward it." },
  ],
  cues: [
    {
      at: 5000,
      tone: 'question',
      observation: 'They handed you a deadline.',
      action: 'Ask what happens if the decision slips.',
    },
    {
      at: 12000,
      tone: 'signal',
      observation: 'Budget, not preference, is driving the date.',
      action: 'Ask which option they would pick if the date moved.',
    },
    {
      at: 19000,
      tone: 'risk',
      observation: 'One buyer, two different answers.',
      action: 'Ask who else must agree and when you can talk to them.',
    },
    {
      at: 27000,
      tone: 'opportunity',
      observation: 'You found the real decision maker.',
      action: 'Offer a one-page summary for that conversation.',
    },
    {
      at: 34000,
      tone: 'signal',
      observation: 'They will forward it — give them something short.',
      action: 'Send one page today, with the ask at the top.',
    },
  ],
  recap: {
    summary:
      'The deadline is driven by this year\u2019s budget line, and the real decision maker is a director who returns next Monday.',
    keyPoints: [
      'Decision required by the end of the month',
      'Missing the date risks losing the budget line',
      'The team prefers the larger option, the buyer prefers the middle one',
      'A director makes the final call and returns Monday',
    ],
    commitments: [
      'You will send a one-page summary today',
      'They will forward it to the director',
    ],
    missed: [
      'The exact budget ceiling was never stated',
      'No decision meeting was booked for when the director returns',
      'The larger option was never costed',
    ],
    nextActions: [
      'Send a one-page summary with the recommendation at the top',
      'Ask for a decision slot next Monday or Tuesday',
      'Price the larger option so the trade-off is explicit',
    ],
  },
};

export const SCENARIOS: MockScenario[] = [negotiation, sales, customer, meeting, difficult, other];

export function getScenario(preset: string): MockScenario {
  return SCENARIOS.find((scenario) => scenario.preset === preset) ?? other;
}
