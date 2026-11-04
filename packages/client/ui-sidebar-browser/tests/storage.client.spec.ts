import { expect, it } from 'vitest'
import { browserSessionStorage } from '../src/client/electron/storage.ts'

it('uses separate storage accounts for separate Sessions without consulting Workspace membership', async () => {
  const signal = new AbortController().signal
  const first = await browserSessionStorage('first', signal)
  const second = await browserSessionStorage('second', signal)
  expect({ first, second }).toMatchInlineSnapshot(`
    {
      "first": "session:first",
      "second": "session:second",
    }
  `)
  expect(first).not.toBe(second)
})

it('shares one account across tabs and independent guest lifetimes in the same Session', async () => {
  const first = await browserSessionStorage('session', new AbortController().signal)
  const second = await browserSessionStorage('session', new AbortController().signal)
  expect(first).toBe(second)
})

it('rejects a closed guest before allocating storage', async () => {
  const lifetime = new AbortController()
  const failure = new Error('tab closed')
  lifetime.abort(failure)
  await expect(browserSessionStorage('session', lifetime.signal)).rejects.toBe(failure)
})
