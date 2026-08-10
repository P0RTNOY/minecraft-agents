export const BOOTSTRAP_TEST_AREA = {
  minimum: -16,
  maximum: 16,
  floorY: 199,
  playerY: 200
} as const

export function bootstrapPlatformCommands(): string[] {
  const { minimum, maximum, floorY, playerY } = BOOTSTRAP_TEST_AREA
  return [
    'difficulty peaceful',
    `forceload add ${minimum} ${minimum} ${maximum} ${maximum}`,
    `fill ${minimum} ${playerY} ${minimum} ${maximum} ${playerY + 2} ${maximum} air`,
    `fill ${minimum} ${floorY} ${minimum} ${maximum} ${floorY} ${maximum} stone`,
    `fill ${minimum} ${playerY} ${minimum} ${maximum} ${playerY + 2} ${minimum} barrier`,
    `fill ${minimum} ${playerY} ${maximum} ${maximum} ${playerY + 2} ${maximum} barrier`,
    `fill ${minimum} ${playerY} ${minimum} ${minimum} ${playerY + 2} ${maximum} barrier`,
    `fill ${maximum} ${playerY} ${minimum} ${maximum} ${playerY + 2} ${maximum} barrier`
  ]
}

export function bootstrapRunResetCommands(): string[] {
  const { minimum, maximum, playerY } = BOOTSTRAP_TEST_AREA
  return [
    `fill ${minimum + 1} ${playerY} ${minimum + 1} ${maximum - 1} ${playerY + 2} ${maximum - 1} air`,
    `kill @e[type=item,x=${minimum},y=${playerY},z=${minimum},dx=${maximum - minimum},dy=3,dz=${maximum - minimum}]`
  ]
}

export function bootstrapWorldCleanupCommands(): string[] {
  const { minimum, maximum, floorY, playerY } = BOOTSTRAP_TEST_AREA
  return [
    `fill ${minimum} ${floorY} ${minimum} ${maximum} ${playerY + 2} ${maximum} air`,
    'forceload remove all',
    'difficulty easy'
  ]
}
