/** Step output `version` from package.json: the docker job tags and labels the image with it. */
import { packageVersion, setOutput } from './common.ts';

setOutput('version', packageVersion());
