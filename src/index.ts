import {analyze} from "./analyze";
import {update} from "./cache";
import {writeSnapshot} from "./history";
import {generateReport} from "./report";


await update();
await analyze();
await writeSnapshot(); // before the report: it reads history back to compute deltas
await generateReport();