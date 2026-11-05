import { WorkflowCenter } from '../../../components/workflow-center';
export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorkflowCenter id={id} />;
}
