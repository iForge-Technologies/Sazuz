import type { Metadata } from 'next';
import { workId } from '@sazuz/core/work';
import { ApprovalInbox } from '../../components/approval-inbox';
export const metadata: Metadata = {
  title: 'Approvals · Sazuz',
  description: 'Review proposed actions and uncertain outcomes.',
};
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ missionId?: string }>;
}) {
  const missionId = workId.safeParse((await searchParams).missionId);
  return <ApprovalInbox {...(missionId.success ? { missionId: missionId.data } : {})} />;
}
