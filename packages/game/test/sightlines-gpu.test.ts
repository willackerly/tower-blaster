// PT1 (agent playtest round 1: B2 opened on a field of towers hiding the cathedral and the crowns): every level
// with crowns or heritage opens on a view showing them, read off the renderer's ID pass on the game page at the
// desktop and phone shapes, under the page's real HUD. Chamber levels and the city levels each have a file (the
// city ones load 5,000 bodies); view.test.ts checks every level the same way on the CPU (sightlines.ts).
// The chambers at the desktop shape; the phone shape is sightlines-gpu-phone.test.ts (one shape a file, each under
// CI's 300 s). The suite is chamberSightSuite in sightlines-gpu.ts.
import { chamberSightSuite } from './sightlines-gpu.ts';

chamberSightSuite('desktop');
