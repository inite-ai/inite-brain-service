/**
 * Realistic message-shape fixtures for rent vertical scenarios. Kept
 * separate from scenario declarations so we can iterate on text
 * (LLM-extraction-sensitive) without touching scenario structure.
 */

export const rentMessages = {
  annaHeating:
    'Hi, this is Anna Schmidt. The radiator in my unit at 14 Birchwood has been making banging noises for three days and the heat barely works. I called maintenance Monday and nobody came. Please escalate.',

  annaUpgradeIntent:
    "Quick note from Anna — I'm thinking of upgrading to the platinum plan once this maintenance issue is sorted. The valet parking would be useful for my schedule.",

  bjornPaymentFail:
    'Hello, my name is Bjorn Madsen and I just got a notification that my last rent payment was declined. I changed my card last week, can you help update it on the system?',

  zoeStormDamage:
    "It's Zoe at unit 7B. Storm last night took two roof tiles off — water came through the ceiling above my bed. I have photos. Need someone to come look ASAP.",

  zoeFollowUp:
    'Following up on the roof tile thing — kitchen ceiling is now sagging too. This is getting worse.',
};
