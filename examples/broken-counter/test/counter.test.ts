import assert from 'node:assert/strict'
import { add } from '../src/counter.ts'

assert.equal(add(2, 3), 5)
assert.equal(add(-1, 4), 3)

console.log('broken-counter tests passed')
