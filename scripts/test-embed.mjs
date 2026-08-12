import { embedText, getEmbeddingStatus, warmEmbeddings } from '../server/embeddings.ts'

warmEmbeddings()
const t = Date.now()
const v = await embedText('local private note embeddings for mine')
console.log('status', getEmbeddingStatus())
console.log('dim', v.length, 'ms', Date.now() - t)
console.log('sample', Array.from(v.slice(0, 5)))
