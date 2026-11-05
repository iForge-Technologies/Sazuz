import { ChunkView } from '../../../../components/knowledge-center';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ChunkView id={id} />;
}
