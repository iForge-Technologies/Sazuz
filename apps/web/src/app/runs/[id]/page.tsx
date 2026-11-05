import { RunWorkspace } from '../../../components/run-workspace';
export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunWorkspace key={id} id={id} />;
}
