import type { Metadata } from 'next';
import { MissionWorkspace } from '../../components/mission-workspace';
export const metadata: Metadata = {
  title: 'Missions · Sazuz',
  description: 'Goals, progress, approvals and budgets for your team.',
};
export default function MissionsPage() {
  return <MissionWorkspace />;
}
