import { expect, test } from 'vitest'
import { PACKAGE_NAME } from './index'

test('@bullet/db package shell is wired', () => {
  expect(PACKAGE_NAME).toBe('@bullet/db')
})
