import {analyze} from "./analyze";
import {update} from "./cache";
import {generateReport} from "./report";


await update();
await analyze();
await generateReport();