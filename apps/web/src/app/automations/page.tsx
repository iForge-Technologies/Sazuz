import type { Metadata } from 'next';
import { AutomationCenter } from '../../components/automation-center';

export const metadata: Metadata = {
  title: 'Automations · Sazuz',
  description: 'Schedules, notifications, digests and Telegram pairing.',
};

export default function AutomationsPage() {
  return <AutomationCenter />;
}
