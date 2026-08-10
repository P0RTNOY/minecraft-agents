export const BOOTSTRAP_TEST_AREA = {
  minimum: -16,
  maximum: 16,
  floorY: 199,
  playerY: 200
} as const

interface BootstrapStartSnapshot {
  health: number
  food: number
  position: { x: number, y: number, z: number }
  inventory: ReadonlyArray<{ name: string, count: number }>
}

interface BootstrapStartObservation {
  snapshot: BootstrapStartSnapshot
  supportBlock: string | null
}

export function isBootstrapStartState(
  snapshot: BootstrapStartSnapshot,
  supportBlock: string | null
): boolean {
  const { playerY } = BOOTSTRAP_TEST_AREA
  return snapshot.health === 20 &&
    snapshot.food === 20 &&
    Math.abs(snapshot.position.x - 0.5) <= 0.01 &&
    Math.abs(snapshot.position.y - playerY) <= 0.01 &&
    Math.abs(snapshot.position.z - 0.5) <= 0.01 &&
    snapshot.inventory.length === 1 &&
    snapshot.inventory[0]?.name === 'oak_log' &&
    snapshot.inventory[0].count === 3 &&
    supportBlock === 'stone'
}

export async function waitForBootstrapStartState(
  observe: () => BootstrapStartObservation,
  waitForTick: () => Promise<void>,
  maxChecks = 20
): Promise<boolean> {
  if (!Number.isInteger(maxChecks) || maxChecks < 1) {
    throw new Error('Bootstrap start-state checks must be a positive integer.')
  }

  for (let check = 0; check < maxChecks; check += 1) {
    const observation = observe()
    if (isBootstrapStartState(
      observation.snapshot,
      observation.supportBlock
    )) return true
    if (check + 1 < maxChecks) await waitForTick()
  }

  return false
}

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
    `forceload remove ${minimum} ${minimum} ${maximum} ${maximum}`,
    'difficulty easy'
  ]
}
