import { notFound } from 'next/navigation';
import { workId } from '@sazuz/core/work';
import { MissionWorkspace } from '../../../components/mission-workspace';
export { metadata } from '../page';
export default async function MissionPage({ params }: { params: Promise<{ id: string }> }) {
  const id = workId.safeParse((await params).id);
  if (!id.success) notFound();
  return <MissionWorkspace initialId={id.data} />;
}
