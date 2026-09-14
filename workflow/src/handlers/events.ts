export async function main(event: { Records?: unknown[] }) {
  console.log('Received event', JSON.stringify(event));
  return { batchItemFailures: [] };
}
