import type { BuildTool, CommodityResource } from '../core/types';

export const MIN_CONTROL_TARGET_CSS_PX = 44;

export type ImmediateUICommand =
  | { kind: 'acceleration' }
  | { kind: 'upgrade' }
  | { kind: 'transfer'; sourceStorageId: string; resource: CommodityResource; amount: number }
  | { kind: 'toggle-auto'; storageId: string };

export interface ImmediateUICommandHooks {
  setTool: (tool: BuildTool) => void;
  toggleLogisticsAcceleration: () => void;
  upgradeSelected: () => void;
  toggleDepotAutoSupply: (storageId: string) => void;
}

export function dispatchImmediateUICommand(command: ImmediateUICommand, hooks: ImmediateUICommandHooks): void {
  if (command.kind === 'acceleration') hooks.toggleLogisticsAcceleration();
  else if (command.kind === 'upgrade') hooks.upgradeSelected();
  else if (command.kind === 'toggle-auto') hooks.toggleDepotAutoSupply(command.storageId);
  else hooks.setTool({
    kind: 'transfer', sourceStorageId: command.sourceStorageId, resource: command.resource, amount: command.amount,
  });
}
