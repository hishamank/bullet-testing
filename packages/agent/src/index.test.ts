import { expect, test } from 'vitest'
import { PACKAGE_NAME } from './index'

test('@bullet/agent package shell is wired', () => {
  expect(PACKAGE_NAME).toBe('@bullet/agent')
})
