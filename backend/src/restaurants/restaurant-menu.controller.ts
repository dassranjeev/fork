import { Body, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RestaurantController, RestaurantRoles } from '../common/decorators';
import { RestaurantRole } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { MenuService } from './menu.service';
import { resolveRestaurantId } from './restaurants.util';
import {
  CategoryDto,
  CsvImportDto,
  EightySixDto,
  ItemDto,
  ModifierGroupDto,
  ModifierOptionDto,
  PrepTargetsDto,
  ReorderDto,
  SetGroupsDto,
  UpdateCategoryDto,
  UpdateGroupDto,
  UpdateItemDto,
  UpdateOptionDto,
} from './dto';

const MANAGERS = [RestaurantRole.OWNER, RestaurantRole.LOCATION_MANAGER];

/** Full menu management (spec §4.3): categories, items, modifier groups/options, combos, dayparts, 86/restock, CSV import/export. */
@RestaurantController('menu')
export class RestaurantMenuController {
  constructor(private menu: MenuService) {}

  private rid(user: AuthUser, restaurantId?: string) {
    return resolveRestaurantId(user, restaurantId);
  }

  @Get()
  tree(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string, @Query('includeInactive') includeInactive?: string) {
    return this.menu.tree(this.rid(user, restaurantId), includeInactive !== 'false');
  }

  // ---- categories ----
  @Post('categories')
  @RestaurantRoles(...MANAGERS)
  createCategory(@CurrentUser() user: AuthUser, @Body() dto: CategoryDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.createCategory(this.rid(user, restaurantId), dto);
  }

  @Patch('categories/reorder')
  @RestaurantRoles(...MANAGERS)
  reorderCategories(@CurrentUser() user: AuthUser, @Body() dto: ReorderDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.reorderCategories(this.rid(user, restaurantId), dto.ids);
  }

  @Patch('categories/:id')
  @RestaurantRoles(...MANAGERS)
  updateCategory(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateCategoryDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.updateCategory(this.rid(user, restaurantId), id, dto);
  }

  @Delete('categories/:id')
  @RestaurantRoles(...MANAGERS)
  deleteCategory(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string, @Query('moveItemsTo') moveItemsTo?: string) {
    return this.menu.deleteCategory(this.rid(user, restaurantId), id, moveItemsTo);
  }

  // ---- items ----
  @Post('items')
  @RestaurantRoles(...MANAGERS)
  createItem(@CurrentUser() user: AuthUser, @Body() dto: ItemDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.createItem(this.rid(user, restaurantId), dto);
  }

  @Patch('items/reorder')
  @RestaurantRoles(...MANAGERS)
  reorderItems(@CurrentUser() user: AuthUser, @Body() dto: ReorderDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.reorderItems(this.rid(user, restaurantId), dto.ids);
  }

  @Get('items/:id')
  getItem(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    return this.menu.getItem(this.rid(user, restaurantId), id);
  }

  @Patch('items/:id')
  @RestaurantRoles(...MANAGERS)
  updateItem(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateItemDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.updateItem(this.rid(user, restaurantId), id, dto);
  }

  @Delete('items/:id')
  @RestaurantRoles(...MANAGERS)
  deleteItem(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    return this.menu.deleteItem(this.rid(user, restaurantId), id);
  }

  @Post('items/:id/groups')
  @RestaurantRoles(...MANAGERS)
  setItemGroups(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SetGroupsDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.setItemGroups(this.rid(user, restaurantId), id, dto.groupIds);
  }

  @Post('items/:id/86')
  @RestaurantRoles(...MANAGERS, RestaurantRole.CASHIER, RestaurantRole.KITCHEN)
  eightySixItem(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: EightySixDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.eightySix(this.rid(user, restaurantId), id, dto);
  }

  @Post('items/:id/restock')
  @RestaurantRoles(...MANAGERS, RestaurantRole.CASHIER, RestaurantRole.KITCHEN)
  restockItem(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    return this.menu.restockItem(this.rid(user, restaurantId), id);
  }

  // ---- modifier groups & options ----
  @Post('groups')
  @RestaurantRoles(...MANAGERS)
  createGroup(@CurrentUser() user: AuthUser, @Body() dto: ModifierGroupDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.createGroup(this.rid(user, restaurantId), dto);
  }

  @Get('groups/:id')
  getGroup(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    return this.menu.getGroup(this.rid(user, restaurantId), id);
  }

  @Patch('groups/:id')
  @RestaurantRoles(...MANAGERS)
  updateGroup(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateGroupDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.updateGroup(this.rid(user, restaurantId), id, dto);
  }

  @Delete('groups/:id')
  @RestaurantRoles(...MANAGERS)
  deleteGroup(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    return this.menu.deleteGroup(this.rid(user, restaurantId), id);
  }

  @Post('groups/:id/items/:itemId')
  @RestaurantRoles(...MANAGERS)
  attachGroup(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('itemId') itemId: string, @Query('restaurantId') restaurantId?: string) {
    return this.menu.attachGroup(this.rid(user, restaurantId), itemId, id);
  }

  @Delete('groups/:id/items/:itemId')
  @RestaurantRoles(...MANAGERS)
  detachGroup(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('itemId') itemId: string, @Query('restaurantId') restaurantId?: string) {
    return this.menu.detachGroup(this.rid(user, restaurantId), itemId, id);
  }

  @Post('groups/:id/options')
  @RestaurantRoles(...MANAGERS)
  createOption(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ModifierOptionDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.createOption(this.rid(user, restaurantId), id, dto);
  }

  @Patch('options/:id')
  @RestaurantRoles(...MANAGERS)
  updateOption(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateOptionDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.updateOption(this.rid(user, restaurantId), id, dto);
  }

  @Delete('options/:id')
  @RestaurantRoles(...MANAGERS)
  deleteOption(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    return this.menu.deleteOption(this.rid(user, restaurantId), id);
  }

  @Post('options/:id/86')
  @RestaurantRoles(...MANAGERS, RestaurantRole.CASHIER, RestaurantRole.KITCHEN)
  eightySixOption(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: EightySixDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.eightySixOption(this.rid(user, restaurantId), id, dto);
  }

  @Post('options/:id/restock')
  @RestaurantRoles(...MANAGERS, RestaurantRole.CASHIER, RestaurantRole.KITCHEN)
  restockOption(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    return this.menu.restockOption(this.rid(user, restaurantId), id);
  }

  // ---- prep targets ----
  @Get('prep-targets')
  prepTargets(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string) {
    return this.menu.prepTargets(this.rid(user, restaurantId));
  }

  @Post('prep-targets')
  @RestaurantRoles(...MANAGERS)
  setPrepTargets(@CurrentUser() user: AuthUser, @Body() dto: PrepTargetsDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.setPrepTargets(this.rid(user, restaurantId), dto.targets);
  }

  // ---- CSV import / export ----
  @Get('csv')
  async exportCsv(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string) {
    return { csv: await this.menu.exportCsv(this.rid(user, restaurantId)) };
  }

  @Post('csv')
  @RestaurantRoles(...MANAGERS)
  importCsv(@CurrentUser() user: AuthUser, @Body() dto: CsvImportDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.importCsv(this.rid(user, restaurantId), dto.csv, dto.mode);
  }
}
