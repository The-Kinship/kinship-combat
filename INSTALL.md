# Testing the plugin (piece 1)

## A. Get the build
1. Put this folder's contents in a new GitHub repo `The-Kinship/kinship-plugin` (upload the files,
   including the hidden `.github` folder).
   If `.github` doesn't show up after uploading, make it by hand: **Add file > Create new file**, type the name
   `.github/workflows/build.yml` (the slashes make the folders), paste in the contents of that file, and commit.
2. On GitHub open the **Actions** tab. A run called "Build plugin" starts by itself
   (or press **Run workflow**). Wait for the green check (about 2 minutes).
3. Click the run, scroll to **Artifacts**, download **KinshipPlugin**, and unzip it to a folder you will keep,
   for example `C:\KinshipPlugin\`. You should see `KinshipPlugin.dll` in it.
If the run shows a red X, open it and send me a screenshot of the failing step.

## B. Load it in the game (dev plugin)
1. In game: `/xlsettings` > **Experimental** > **Dev Plugin Locations**.
2. Add the full path to the dll, e.g. `C:\KinshipPlugin\KinshipPlugin.dll`, press the + and Save.
3. `/xlplugins` > **Dev Tools** > **Installed Dev Plugins**, and enable **The Kinship**.
4. Type `/kinship`.

You should see The Kinship, the tagline, Crystal / Mateus, and the member count from the sheet.
