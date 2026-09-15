/**
 * Barrel of the Sales / CRM commands (plan 6.5). Registration is a side effect
 * of importing each service; `operations/register-commands.ts` imports this file
 * once so every entry point that executes commands by type (batch endpoint,
 * jobs, AI tools) has the CRM catalog.
 *
 * | command | aggregate | permission / actor |
 * |---|---|---|
 * | crm.stage.create / update / reorder | none | crm.manage_stages (people) |
 * | crm.opportunity.create / create_from_conversation | none | crm.manage |
 * | crm.opportunity.update / move_stage / link_quote / mark_won / mark_lost / mark_dormant | opportunity (version) | crm.manage |
 * | crm.opportunity.record_activity / link_sales_order | none | crm.manage (link also from the system) |
 * | crm.opportunity.link_case / crm.conversation.touch / crm.quote.changed | none | system |
 * | crm.radar.snooze / dismiss / convert_to_task | radar_signal (version) | crm.radar |
 * | crm.radar.set_explanation | none | crm.radar (or system) |
 * | crm.sales_order.readback_mismatch | none | system |
 *
 * The Zoho write itself (`createSalesOrderFromQuote`) is not a command: it is an
 * external call protected by the `SalesOrderWriteRequest` ledger, and it records
 * its local effects through the commands above.
 */

import './pipeline-service';
import './opportunities-service';
import './radar-service';
import './sales-order-write-service';

export { CRM_COMMANDS } from './types';
