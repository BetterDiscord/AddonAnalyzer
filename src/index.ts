import {analyze} from "./analyze";
import {update} from "./cache";
import {writeSnapshot} from "./history";
import {updateImports} from "./importcache";
import {generateReport} from "./report";


await update();
await updateImports(); // cache theme @import graphs before analysis so remote CSS is first-class
await analyze();
await writeSnapshot(); // before the report: it reads history back to compute deltas
await generateReport();