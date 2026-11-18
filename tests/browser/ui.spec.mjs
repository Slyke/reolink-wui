import { expect, test } from '@playwright/test';
import { createServer, request } from 'node:http';
import { createServer as tcp } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from '../../dist/server/api.js';
import { configSchema } from '../../dist/server/config.js';
import { passwordHash } from '../../dist/server/auth.js';
import { fixtureBridge, eventually, localPassword, hop, uuid } from '../support.mjs';

const reserve = async () => {
  const listener = tcp().listen(0, '127.0.0.1');
  await once(listener,'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
};

const expectHover = async (page, button) => {
  await page.mouse.move(0, 0);
  const background = () => button.evaluate(element => getComputedStyle(element).backgroundColor);
  const resting = await background();
  await button.hover();
  await expect.poll(background).not.toBe(resting);
};

for (const mode of ['browser','proxy']) {
  test('navigate workspace, search grants and open private QR in ' + mode + ' mode', async ({ page }) => {
    test.setTimeout(45000);
    page.setDefaultTimeout(6000);
    const bridge = await fixtureBridge({ previewCameras:['alpha','beta'],recordings:true,recordingCount:3,apiEvents:true });
    const remoteBridge = await fixtureBridge({websocket:true,apiEvents:true,namePrefix:'Remote ',imageSettings:false});
    const directory = await mkdtemp(join(tmpdir(),'wui-browser-'));
    const uiPort = await reserve();
    const apiPort = await reserve();
    const ingressPort = mode === 'browser' ? await reserve() : uiPort;
    const publicOrigin = 'http://127.0.0.1:' + ingressPort;
    const apiOrigin = 'http://127.0.0.1:' + apiPort;
    const conf = {
      publicOrigin, auth:{mode:'local'}, database:{driver:'sqlite',path:join(directory,'app.sqlite')},
      bridges:[bridge.config],
      httpApi: {
        mode, browserBasePath:'/ui/api',
        proxy:{ basePath:'/front', upstreamBasePath:'/node/v3', upstreamBaseUrl:apiOrigin }
      },
      ...(mode==='proxy'?{forward:{secret:hop,peers:['127.0.0.1']}}:{})
    };
    const file = join(directory,'wui.json5');
    await writeFile(file,JSON.stringify(conf));
    const { app,runtime } = await api({ config:configSchema.parse(conf) });
    const edge = mode === 'browser' ? createServer((incoming,outgoing) => {
      const target = incoming.url.startsWith('/ui/api/') ? apiOrigin : 'http://127.0.0.1:' + uiPort;
      const proxy = request(new URL(incoming.url,target),{method:incoming.method,headers:incoming.headers}, from => {
        outgoing.writeHead(from.statusCode, from.headers); from.pipe(outgoing);
      });
      proxy.on('error', () => {outgoing.statusCode=502; outgoing.end();});
      outgoing.on('close',() => proxy.destroy());
      incoming.pipe(proxy);
    }).listen(ingressPort,'127.0.0.1') : undefined;
    const ui = spawn(process.execPath,['build/index.js'], {
      env:{...process.env,WUI_CONFIG:file,ORIGIN:publicOrigin,HOST:'127.0.0.1',PORT:String(uiPort)}, stdio:'ignore'
    });
    try {
      await app.listen({ host:'127.0.0.1',port:apiPort });
      const account = uuid();
      const viewer = uuid();
      await runtime.sql.query('INSERT INTO accounts VALUES ($1,$2,$3,$4,1,1)',
        account,'Test operator','fixture-user',await passwordHash({ password:localPassword }));
      await runtime.sql.query('INSERT INTO accounts VALUES ($1,$2,$3,$4,0,1)',
        viewer,'Test viewer','fixture-viewer',await passwordHash({ password:localPassword }));
      const [camera] = await runtime.sql.query('SELECT id FROM cameras WHERE remote_id=$1','alpha');
      await runtime.sql.query('INSERT INTO grants VALUES ($1,$2,$3)',viewer,camera.id,JSON.stringify(['view','events','media.live']));
      await eventually(async () => fetch(publicOrigin+'/livez').then(response => response.ok,()=>false));
      await eventually(() => runtime.bridges.get('lab').feedReady);
      const prefix = mode === 'browser' ? '/ui/api' : '/front';
      const observed = [];
      const errors = [];
      page.on('request', request => observed.push({url:request.url(),body:request.postData()}));
      page.on('pageerror', error => errors.push(error.message));
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: publicOrigin });
      await page.goto(publicOrigin);
      await page.evaluate(() => {
        localStorage.setItem('d4rk-styleguide-palette','retro');
        document.cookie='d4rk-styleguide-theme=light; Path=/; SameSite=Lax';
      });
      await page.getByLabel('Username').fill('fixture-user');
      await page.getByLabel('Password',{exact:true}).fill(localPassword);
      const login = page.getByRole('button',{name:'Sign in with password'});
      await expectHover(page, login);
      await login.click();
      await expect(page).toHaveURL(publicOrigin+'/monitor');
      await expect(page.locator('html')).toHaveAttribute('data-palette','retro');
      await expect(page.locator('html')).toHaveAttribute('data-theme','light');
      await page.getByRole('button',{name:/Loading dock/}).click();
      await expect(page.getByRole('heading',{name:'Loading dock'})).toBeVisible();
      await expect(page.getByText('Event feed connected')).toBeVisible();
      expect(observed.some(item => new URL(item.url).pathname === prefix + '/v1/events')).toBe(true);
      const moreInfo = page.getByRole('button',{name:'More info',exact:true});
      await runtime.bridges.get('lab').refreshInventory();
      await expect(moreInfo).toHaveCount(0);
      await bridge.disconnect();
      await moreInfo.click();
      const gapDetails = page.getByRole('dialog',{name:'Event feed details'});
      await expect(gapDetails.getByRole('heading',{name:'Bridge event connection interrupted'})).toBeVisible();
      await expect(gapDetails.getByText('Fixture bridge · MQTT',{exact:true})).toBeVisible();
      await expect(gapDetails.getByText(/affected event IDs and counts are unknown/)).toBeVisible();
      await page.mouse.click(2,2);
      await expect(gapDetails).toBeHidden();
      await bridge.reconnect();
      await eventually(() => {
        const upstream = runtime.bridges.get('lab');
        return upstream.feedReady && upstream.state('alpha').get('availability')?.online;
      });
      await expect(page.getByText('Event feed connected')).toBeVisible();
      await page.getByRole('button',{name:'Refresh',exact:true}).click();
      await expect(moreInfo).toHaveCount(0);
      bridge.event('alpha','motion',{
        rule_id:'rule-4',
        objects:[{class:'person',confidence:0.91,tracking_id:'42',bounding_box:{
          left:0,top:12,right:130,bottom:180,coordinate_space:'pixels_top_left',
          reference_frame:'Camera substream',frame_width:640,frame_height:360
        }}]
      });
      for (let count = 0; count < 14; count++) bridge.event('alpha','pet',{active:false});
      const feed = page.getByRole('region',{name:'Event feed'});
      const liveView = page.getByRole('region',{name:'Live view'});
      const motion = feed.getByRole('button',{name:/^Motion detection /});
      await expect(motion).toHaveCount(1);
      await expect(feed.getByRole('button',{name:/^Pet /})).toHaveCount(14);
      const eventList = feed.getByRole('list');
      expect(await eventList.evaluate(element => element.scrollHeight)).toBeGreaterThan(
        await eventList.evaluate(element => element.clientHeight)
      );
      expect((await feed.boundingBox()).height).toBeLessThanOrEqual((await liveView.boundingBox()).height + 1);
      const detail = page.getByRole('dialog',{name:'Event details'});
      await feed.getByRole('button',{name:/^Pet /}).first().click();
      await expect(detail.getByText('Object coordinates are unavailable for this event.')).toHaveCount(0);
      await expect(detail.getByRole('heading',{name:'Bounding box'})).toHaveCount(0);
      await page.evaluate(() => Object.defineProperty(navigator.clipboard,'writeText',{
        configurable:true,
        value:() => Promise.reject(new DOMException('Clipboard access denied','NotAllowedError'))
      }));
      await detail.getByRole('button',{name:'Copy JSON'}).click();
      const manual = detail.getByRole('textbox',{name:'Event JSON'});
      await expect(manual).toBeVisible();
      const fallback = JSON.parse(await manual.inputValue());
      expect(fallback.event).toMatchObject({ type:'pet', active:false });
      expect(fallback.event).not.toHaveProperty('objects');
      await page.evaluate(() => { delete navigator.clipboard.writeText; });
      await detail.getByRole('button',{name:'Close',exact:true}).click();

      const allTypes = feed.getByRole('button',{name:'Event type All types'});
      const searchBox = feed.getByRole('searchbox',{name:'Search events'});
      const filterSize = await allTypes.boundingBox();
      const searchSize = await searchBox.boundingBox();
      expect(filterSize.height).toBe(searchSize.height);
      expect(filterSize.width).toBeCloseTo(searchSize.width, 0);
      expect(filterSize.y).toBeCloseTo(searchSize.y, 0);
      await allTypes.click();
      const typeSearch = page.getByRole('combobox',{name:'Search Event type'});
      await typeSearch.fill('motion');
      await typeSearch.press('Enter');
      await expect(feed.getByRole('button',{name:/^Pet /})).toHaveCount(0);
      await feed.getByRole('searchbox',{name:'Search events'}).fill('missing');
      await expect(feed.getByText('No events match your filters.')).toBeVisible();
      await feed.getByRole('searchbox',{name:'Search events'}).fill('rule-4');
      await expect(motion.locator('time')).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      await expectHover(page, motion);
      await motion.click();
      await expect(detail.getByRole('heading',{name:'Bounding box'})).toBeVisible();
      await expect(detail.getByText('0',{exact:true})).toBeVisible();
      await expect(detail.getByText('640',{exact:true})).toBeVisible();
      await expect(detail.getByText('42',{exact:true})).toBeVisible();
      await expect(detail.getByText('Camera substream',{exact:true})).toBeVisible();
      await detail.getByRole('button',{name:'Copy JSON'}).click();
      await expect(detail.getByRole('status')).toHaveText('Event JSON copied.');
      const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
      expect(copied).toMatchObject({
        id:expect.any(String), observedAt:expect.any(Number),
        event:{ type:'motion', ruleId:'rule-4', objects:[{ class:'person', trackId:'42', confidence:0.91, box:{
          left:0, top:12, right:130, bottom:180, coordinateSpace:'pixels_top_left',
          referenceFrame:'Camera substream', frameWidth:640, frameHeight:360
        }}]}
      });
      expect(copied.event).not.toHaveProperty('vendor');
      await detail.getByRole('heading',{name:'Bounding box'}).click();
      await expect(detail).toBeVisible();
      await page.mouse.click(2,2);
      await expect(detail).toBeHidden();
      const expandEvents=feed.getByRole('button',{name:'Expand',exact:true});
      await expect(expandEvents.locator('svg')).toHaveCount(1);
      await expect(expandEvents).toHaveText('');
      await expandEvents.click();
      const expanded = page.getByRole('dialog',{name:'Event feed'});
      await expect(expanded).toBeVisible();
      await expanded.getByRole('button',{name:/^Motion detection /}).click();
      await expect(detail.getByText('0.91',{exact:true})).toBeVisible();
      await detail.getByRole('button',{name:'Back to feed'}).click();
      await expect(expanded).toBeVisible();
      await page.mouse.click(2,2);
      await expect(expanded).toBeHidden();
      await page.setViewportSize({width:375,height:812});
      expect((await feed.boundingBox()).height).toBeLessThanOrEqual((await liveView.boundingBox()).height + 1);
      await page.setViewportSize({width:1280,height:720});
      await expect(page.getByRole('button',{name:/Second camera/})).toBeVisible();
      const previewBaseline = bridge.previewRequests.length;
      await page.getByRole('link',{name:'Dashboard',exact:true}).click();
      await expect(page).toHaveURL(publicOrigin+'/dashboard');
      for (const name of ['Loading dock','Second camera']) {
        const preview = page.getByRole('img',{name:name+' camera preview'});
        await expect(preview).toBeVisible();
        await preview.evaluate(image => image.decode());
      }
      const betaPreviews = () => bridge.previewRequests.slice(previewBaseline).filter(request => request.camera === 'beta');
      await expect.poll(() => betaPreviews().some(request => request.unchanged)).toBe(true);
      const previews = betaPreviews();
      expect(previews[1].at - previews[0].at).toBeGreaterThanOrEqual(1900);
      const liveResponse = () => page.waitForResponse(response => new URL(response.url()).pathname.startsWith(prefix+'/v1/media/')
        && response.headers()['content-type']?.includes('multipart/x-mixed-replace'));
      const card = page.getByRole('article',{name:'Loading dock'});
      const largeView = page.getByRole('dialog',{name:'Live view · Loading dock'});
      const expandView = card.getByRole('button',{name:'Enlarge live view'});
      const previewTile = await card.getByRole('img',{name:'Loading dock camera preview'}).boundingBox();
      await expandView.click();
      const enlargedPreview = largeView.getByRole('img',{name:'Loading dock camera preview'});
      await expect(enlargedPreview).toBeVisible();
      expect((await enlargedPreview.boundingBox()).width).toBeGreaterThan(previewTile.width);
      await page.mouse.click(2,2);
      await expect(largeView).toBeHidden();
      await expect(expandView).toBeFocused();

      const dashboardPlayback = liveResponse();
      await card.getByRole('button',{name:'Start live stream'}).click();
      await dashboardPlayback;
      const video = largeView.getByRole('img',{name:'Live camera video'});
      await expect.poll(() => video.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
      const quality = largeView.getByRole('combobox',{name:'Stream quality'});
      await expect(quality).toHaveValue('main');
      const switchPlayback = liveResponse();
      const subLease = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/media-sessions')
        && request.postDataJSON()?.stream === 'sub');
      await quality.selectOption('sub');
      await subLease;
      await switchPlayback;
      await expect(largeView.getByRole('link',{name:'Configure playback'})).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(largeView).toBeHidden();
      await page.getByRole('link',{name:'Loading dock',exact:true}).click();
      await expect(page).toHaveURL(publicOrigin+'/monitor?camera='+camera.id);
      await expect(page.getByRole('region',{name:'Event feed'}).getByRole('button',{name:/^Motion detection /})).toHaveCount(1);
      await expect(page.getByRole('button',{name:'Take snapshot'})).toHaveCount(0);
      bridge.detection('alpha','person',false);
      const pill = page.locator('.detection-state').filter({hasText:/Person/});
      await expect(pill).toHaveAttribute('data-status','cleared');
      bridge.detection('alpha','motion',false);
      bridge.detection('alpha','vehicle',false);
      const detectionGrid = page.locator('.detection-grid');
      await expect(detectionGrid.locator('.pill')).toHaveCount(3);
      const layout = await detectionGrid.locator('.pill').evaluateAll(items => items.map(element => element.getBoundingClientRect().width));
      expect(Math.max(...layout) - Math.min(...layout)).toBeLessThan(1);
      const clearedColor = await pill.evaluate(element => getComputedStyle(element).backgroundColor);
      bridge.detection('alpha','person',true);
      await expect(pill).toHaveAttribute('data-status','triggered');
      await expect.poll(() => pill.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(clearedColor);
      bridge.detection('alpha','person',false);
      await expect(pill).toHaveAttribute('data-status','cleared');
      await expect.poll(() => pill.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(clearedColor);

      const forcedPreview = request => new URL(request.url()).pathname === prefix+'/v1/cameras/'+camera.id+'/preview'
        && new URL(request.url()).searchParams.get('refresh') === 'true';
      const manualFrame = page.waitForRequest(forcedPreview);
      const liveTools=liveView.getByRole('group',{name:'Live view actions'});
      await expect(liveTools.getByRole('link',{name:'Recordings',exact:true})).toHaveAttribute('href','/recordings?camera='+camera.id);
      await expect(liveTools.getByRole('link',{name:'Camera settings',exact:true})).toHaveAttribute('href','/settings/cameras?camera='+camera.id);
      for(const name of ['Recordings','Camera settings','Refresh live view','Enlarge live view']) {
        const action=liveTools.getByRole(name==='Recordings'||name==='Camera settings'?'link':'button',{name,exact:true});
        await expect(action).toHaveAttribute('title',name);
        await expect(action.locator('svg')).toHaveCount(1);
      }
      const liveHeading=await liveView.getByRole('heading',{name:'Live view',exact:true}).boundingBox();
      const toolsPosition=await liveTools.boundingBox();
      expect(Math.abs((liveHeading.y+liveHeading.height/2)-(toolsPosition.y+toolsPosition.height/2))).toBeLessThan(3);
      await liveView.getByRole('button',{name:'Refresh live view'}).click();
      await manualFrame;
      const streamResponse = liveResponse();
      await liveView.getByRole('button',{name:'Start live stream'}).click();
      await streamResponse;
      const live = largeView.getByRole('img',{name:'Live camera video'});
      await expect.poll(() => live.evaluate(element => element.naturalWidth)).toBeGreaterThan(0);
      await expect(largeView.getByText('Bridge camera relay',{exact:true})).toHaveCount(0);
      await expect(largeView.getByRole('button',{name:'Refresh live view'})).toHaveCount(0);
      await largeView.getByRole('button',{name:'Stop live stream'}).click();
      await expect(largeView.getByRole('img',{name:/camera preview$/})).toBeVisible();
      await expect(largeView.getByRole('link',{name:'Configure playback'})).toHaveCount(0);
      await largeView.getByRole('button',{name:'Close'}).click();
      await expect(liveView.getByText('Bridge camera relay',{exact:true})).toHaveCount(0);
      const expandIcon=liveView.getByRole('button',{name:'Enlarge live view'});
      const inlineTitle=liveView.getByRole('heading',{name:'Live view',exact:true});
      const iconBounds=await expandIcon.boundingBox();
      const titleBounds=await inlineTitle.boundingBox();
      expect(iconBounds.y).toBeLessThan(titleBounds.y+titleBounds.height);
      expect(await expandIcon.innerText()).toBe('');
      await page.getByRole('link',{name:'Settings',exact:true}).click();
      await expect(page).toHaveURL(publicOrigin+'/settings/appearance');
      await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption('ocean');
      await page.getByRole('combobox',{name:'Mode',exact:true}).selectOption('light');
      await page.getByRole('combobox',{name:'Font',exact:true}).selectOption('georgia');
      await page.getByRole('combobox',{name:'Content width'}).selectOption('1440');
      const appearanceWidths=await page.locator('.appearance-fields select').evaluateAll(items=>items.map(item=>item.getBoundingClientRect().width));
      expect(Math.max(...appearanceWidths)-Math.min(...appearanceWidths)).toBeLessThan(1);
      await page.reload();
      await expect(page.getByRole('heading',{name:'Appearance'})).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-palette','ocean');
      await expect(page.locator('html')).toHaveAttribute('data-theme','light');
      await expect(page.locator('html')).toHaveAttribute('data-font','georgia');
      await expect(page.locator('html')).toHaveAttribute('data-content-width','1440');
      const adminAppearance = await page.evaluate(id => ({
        personal:JSON.parse(localStorage.getItem('reolink-wui:appearance:' + id)),
        legacy:localStorage.getItem('d4rk-styleguide-palette'),
        cookies:document.cookie
      }), account);
      expect(adminAppearance.personal).toEqual({palette:'ocean',theme:'light',font:'georgia',contentWidth:'1440'});
      expect(adminAppearance.legacy).toBeNull();
      expect(adminAppearance.cookies).not.toContain('d4rk-styleguide-');

      await page.getByRole('link',{name:'Default appearance',exact:true}).click();
      const appearanceDefaults = page.getByRole('region',{name:'Default appearance',exact:true});
      await appearanceDefaults.getByRole('combobox',{name:'Theme',exact:true}).selectOption('paper');
      await appearanceDefaults.getByRole('button',{name:'Save defaults'}).click();
      await expect(page.getByText('Confirmed',{exact:true})).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-palette','ocean');

      await page.getByRole('button',{name:'Sign out'}).click();
      await page.getByLabel('Username').fill('fixture-viewer');
      await page.getByLabel('Password',{exact:true}).fill(localPassword);
      await login.click();
      await expect(page.locator('html')).toHaveAttribute('data-palette','paper');
      await page.getByRole('link',{name:'Settings',exact:true}).click();
      await expect(page.getByRole('link',{name:'Default appearance',exact:true})).toHaveCount(0);
      await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption('terminal');
      await expect(page.locator('html')).toHaveAttribute('data-palette','terminal');
      await page.getByRole('button',{name:'Use installation defaults'}).click();
      await expect(page.locator('html')).toHaveAttribute('data-palette','paper');

      await page.getByRole('button',{name:'Sign out'}).click();
      await page.getByLabel('Username').fill('fixture-user');
      await page.getByLabel('Password',{exact:true}).fill(localPassword);
      await login.click();
      await expect(page.locator('html')).toHaveAttribute('data-palette','ocean');
      await page.getByRole('link',{name:'Settings',exact:true}).click();
      await page.getByRole('link',{name:'Accounts',exact:true}).click();
      await expect(page).toHaveURL(publicOrigin+'/settings/accounts');
      await expectHover(page, page.getByRole('button',{name:'Add account'}));

      await page.getByRole('link',{name:'Camera grants'}).click();
      await expect(page).toHaveURL(publicOrigin+'/settings/access');
      const accountPicker = page.getByRole('button',{name:/^Account /});
      await accountPicker.press('ArrowDown');
      const accountSearch = page.getByRole('combobox',{name:'Search Account'});
      await expect(accountSearch).toBeFocused();
      await accountSearch.fill('unmatched');
      await expect(page.getByText('No matching options')).toBeVisible();
      await accountSearch.fill('FIXTURE-USER');
      await accountSearch.press('Enter');
      await expect(page.getByText('Instance administrators have full access to all cameras.')).toBeVisible();
      await expect(page.getByRole('button',{name:/^Camera /})).toBeDisabled();
      await accountPicker.press('ArrowDown');
      await accountSearch.fill('FIXTURE-VIEWER');
      await accountSearch.press('Enter');
      await expect(accountPicker).toHaveAccessibleName('Account Test viewer');
      await expect(accountPicker).toBeFocused();
      const cameraPicker = page.getByRole('button',{name:/^Camera /});
      await cameraPicker.click();
      const cameraSearch = page.getByRole('combobox',{name:'Search Camera'});
      await cameraSearch.fill('DOCK');
      await expect(page.getByRole('option',{name:'Second camera'})).toHaveCount(0);
      await cameraSearch.press('Escape');
      await expect(cameraPicker).toBeFocused();
      await cameraPicker.press('ArrowDown');
      await cameraSearch.fill('DOCK');
      await cameraSearch.press('Enter');
      await expect(page.getByRole('combobox',{name:'Apply preset'})).toHaveValue('viewer');
      await expect(page.getByLabel('View camera and state')).toBeChecked();

      await page.getByRole('link',{name:'Event history',exact:true}).click();
      await expect(page).toHaveURL(publicOrigin+'/settings/events');
      const limit = page.getByRole('spinbutton',{name:'In-memory events to keep per camera'});
      await limit.fill('7');
      await page.getByRole('button',{name:'Save changes'}).click();
      await expect(page.getByText('Confirmed',{exact:true})).toBeVisible();
      await page.reload();
      await expect(limit).toHaveValue('7');
      if(process.env.WUI_TEST_VALKEY) {
        const endpoint=new URL(process.env.WUI_TEST_VALKEY), password=decodeURIComponent(endpoint.password);
        endpoint.password='';
        const storagePicker=page.getByRole('button',{name:/^Event storage /});
        await storagePicker.click();
        await page.getByRole('option',{name:'Valkey',exact:true}).click();
        await page.getByLabel('Valkey URL',{exact:true}).fill(endpoint.href);
        await page.getByLabel('Key prefix',{exact:true}).fill('browser-'+mode+'-'+uuid());
        await page.getByLabel('Password',{exact:true}).fill(password);
        await page.getByRole('button',{name:'Save changes',exact:true}).click();
        await expect(page.getByText('Confirmed',{exact:true})).toBeVisible();
        await page.reload();
        await expect(page.getByLabel('Valkey URL',{exact:true})).toHaveValue(endpoint.href);
        await expect(page.getByLabel('Password',{exact:true})).toHaveValue('');
        await expect(page.getByLabel('Password',{exact:true})).toHaveAttribute('placeholder','Saved. Leave blank to keep.');
        await storagePicker.click();
        await page.getByRole('option',{name:'In memory',exact:true}).click();
        await page.getByRole('button',{name:'Save changes',exact:true}).click();
        await expect(page.getByText('Confirmed',{exact:true})).toBeVisible();
      }

      await page.getByRole('link',{name:'Private bridges',exact:true}).click();
      const inventoryInterval = page.getByRole('spinbutton',{name:'Inventory scan interval (seconds)'});
      await expect(inventoryInterval).toHaveValue('10');
      await expect(inventoryInterval).toHaveAttribute('min','1');
      await expect(inventoryInterval).toHaveAttribute('max','86400');
      await inventoryInterval.fill('2');
      await page.getByRole('button',{name:'Save interval'}).click();
      await expect(page.getByText(/syncs reported camera inventory every 2 seconds/)).toBeVisible();
      await page.reload();
      await expect(inventoryInterval).toHaveValue('2');
      const sourceForm=page.getByRole('form',{name:'Fixture bridge event sources'});
      await sourceForm.getByRole('button',{name:/^Add event source/}).click();
      await sourceForm.getByRole('option',{name:'HTTP API',exact:true}).click();
      await sourceForm.getByRole('button',{name:'Move HTTP API up',exact:true}).click();
      await sourceForm.getByRole('button',{name:'Save event sources'}).click();
      await expect(page.getByText('Confirmed',{exact:true})).toBeVisible();
      await page.reload();
      await expect(sourceForm.getByRole('listitem').first()).toContainText('HTTP API');
      await expect(sourceForm.getByRole('listitem').nth(1)).toContainText('MQTT');
      await page.getByRole('button',{name:'Refresh inventory'}).click();
      await expect(page.locator('time')).toHaveText(/^Refreshed at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      await expect(page.getByText('Confirmed',{exact:true})).toHaveCount(0);
      const connectionPanel=page.getByRole('region',{name:'Bridge connections',exact:true});
      await connectionPanel.getByRole('button',{name:'Add bridge',exact:true}).click();
      const connectionForm=page.getByRole('form',{name:'Bridge connection settings'});
      await connectionForm.getByLabel('Bridge ID',{exact:true}).fill('remote');
      await connectionForm.getByLabel('Bridge name',{exact:true}).fill('Remote bridge');
      await connectionForm.getByLabel('HTTP API URL',{exact:true}).fill(remoteBridge.config.http.url);
      await connectionForm.getByLabel('HTTP API token',{exact:true}).fill(remoteBridge.config.http.token);
      await connectionForm.getByRole('button',{name:'Add destination'}).click();
      await connectionForm.getByLabel('Destination name',{exact:true}).fill('notify');
      await connectionForm.getByLabel('Destination URL',{exact:true}).fill(remoteBridge.config.callbacks.fixture);
      await connectionForm.getByRole('button',{name:'Test bridge connection',exact:true}).click();
      await expect(connectionForm.getByRole('table').getByText('Connected',{exact:true})).toHaveCount(2);
      await connectionForm.getByRole('button',{name:'Save bridge connection',exact:true}).click();
      await expect(connectionForm.getByLabel('Bridge ID',{exact:true})).toHaveValue('remote');
      await page.reload();
      await connectionPanel.getByRole('button',{name:/^Bridge /}).click();
      await page.getByRole('option',{name:/Remote bridge/}).click();
      await expect(connectionForm.getByLabel('HTTP API token',{exact:true})).toHaveValue('');
      await expect(connectionForm.getByLabel('HTTP API token',{exact:true})).toHaveAttribute('placeholder','Saved. Leave blank to keep.');
      const remoteCamera=await eventually(async()=> {
        const rows=await runtime.sql.query('SELECT id FROM cameras WHERE bridge_id=$1 AND remote_id=$2','remote','alpha');
        return rows[0]?.id;
      });
      await page.getByRole('link',{name:'Bridge callbacks',exact:true}).click();
      await page.getByRole('button',{name:/^Bridge /}).click();
      await page.getByRole('option',{name:/Remote bridge/}).click();
      await page.getByLabel('Callback ID',{exact:true}).fill('remote-browser-callback');
      await page.getByRole('button',{name:/^Approved destination /}).click();
      await page.getByRole('option',{name:'notify',exact:true}).click();
      await page.getByLabel('Remote Loading dock',{exact:true}).check();
      await page.getByRole('button',{name:'Add callback',exact:true}).click();
      await expect(page.getByText('remote-browser-callback',{exact:true})).toBeVisible();
      await page.getByRole('button',{name:/^Bridge /}).click();
      await page.getByRole('option',{name:/Fixture bridge/}).click();
      await expect(page.getByText('remote-browser-callback',{exact:true})).toHaveCount(0);
      await page.goto(publicOrigin+'/settings/cameras?camera='+remoteCamera);
      await expect(page.getByRole('heading',{name:'Image orientation',exact:true})).toBeVisible();
      await expect(page.getByText('The connected bridge does not expose image orientation. Update reolink-bridge and refresh camera settings.')).toBeVisible();

      await page.goto(publicOrigin+'/settings/cameras?camera='+camera.id);
      const settingsRefresh = page.getByRole('button',{name:/^Refresh/});
      await expect(settingsRefresh).toHaveCount(1);
      const brightness = page.getByRole('spinbutton',{name:'Brightness',exact:true});
      const sensitivity = page.getByRole('spinbutton',{name:'Sensitivity',exact:true});
      await expect(brightness).toHaveValue('5');
      await expect(sensitivity).toHaveValue('40');
      bridge.setReportedLevels({brightness:17,sensitivity:22});
      await settingsRefresh.click();
      await expect(page.getByText('Camera settings refreshed.')).toBeVisible();
      await expect(brightness).toHaveValue('17');
      await expect(sensitivity).toHaveValue('22');

      const detectionType = page.getByRole('combobox',{name:'Detection type'});
      await detectionType.selectOption('pet');
      const petSettings = page.getByRole('group',{name:'Pet detection settings'});
      await expect(petSettings.getByRole('spinbutton',{name:'Pet sensitivity'})).toHaveValue('60');
      const petDelay = petSettings.getByRole('spinbutton',{name:'Pet delay (seconds)'});
      await expect(petDelay).toHaveValue('0');
      await petDelay.fill('3');
      await page.getByRole('button',{name:'Save Pet settings'}).click();
      await expect.poll(() => bridge.requests.at(-1)).toEqual({setting:'ai_detection',class:'pet',delay_seconds:3});
      await detectionType.selectOption('person');
      await expect(page.getByRole('spinbutton',{name:'Person sensitivity'})).toHaveValue('76');
      await expect(page.getByRole('spinbutton',{name:'Person delay (seconds)'})).toHaveValue('2');
      const source = page.getByRole('combobox',{name:'Video source'});
      await source.selectOption('proxy');
      await page.getByRole('textbox',{name:'RTSP restream URL'}).fill('rtsp://127.0.0.1:8554/sample');
      const playback = page.getByRole('region',{name:'Playback',exact:true});
      const alertMode = playback.getByRole('combobox',{name:'Refresh on alert'});
      await expect(playback.getByText(/check the bridge’s cached preview every 2 seconds/)).toBeVisible();
      await alertMode.selectOption('person');
      await playback.getByRole('button',{name:'Save changes'}).click();
      await expect(playback.getByText('Playback settings saved.')).toBeVisible();
      await page.reload();
      await expect(source).toHaveValue('proxy');
      await expect(alertMode).toHaveValue('person');
      await source.selectOption('direct');
      await playback.getByRole('button',{name:'Save changes'}).click();
      await expect(playback.getByText('Playback settings saved.')).toBeVisible();

      const frameTimings = [];
      const framePath = '**/v1/cameras/'+camera.id+'/preview';
      const delayFrame = async route => {
        const measurement = { start:performance.now() };
        frameTimings.push(measurement);
        const result = await route.fetch();
        if (frameTimings.indexOf(measurement) < 2) await wait(180);
        measurement.end = performance.now();
        await route.fulfill({response:result});
      };
      await page.route(framePath, delayFrame);
      const dashboardFeed = page.waitForResponse(response => new URL(response.url()).pathname === prefix+'/v1/events');
      await page.getByRole('link',{name:'Dashboard',exact:true}).click();
      await dashboardFeed;
      await expect.poll(() => frameTimings.length).toBeGreaterThanOrEqual(2);
      expect(frameTimings[1].start - frameTimings[0].end).toBeGreaterThanOrEqual(1900);
      const dashboardAlert = page.waitForRequest(forcedPreview);
      bridge.event('alpha','person');
      await dashboardAlert;
      await page.unroute(framePath, delayFrame);
      await page.getByRole('link',{name:'Loading dock',exact:true}).click();
      await expect(page.getByText('Event feed connected')).toBeVisible();
      await expect(liveView.getByRole('img',{name:'Loading dock camera preview'})).toBeVisible();
      const monitorAlert = page.waitForRequest(forcedPreview);
      bridge.event('alpha','motion',{objects:[{class:'person'}]});
      await monitorAlert;

      await page.getByRole('link',{name:'Status',exact:true}).click();
      await expect(page).toHaveURL(publicOrigin+'/status');
      const upstreamTable = page.getByRole('table');
      const fixtureRows=upstreamTable.getByRole('row').filter({hasText:'Fixture bridge'});
      const eventRows=fixtureRows.filter({hasText:'Events and camera state'});
      await expect(eventRows.filter({hasText:'MQTT'})).toHaveCount(1);
      await expect(eventRows.filter({hasText:'HTTP'})).toHaveCount(1);
      await expect(fixtureRows.filter({hasText:'Commands'})).toContainText('HTTP');
      await expect(fixtureRows.getByText('Online',{exact:true})).toHaveCount(3);

      await page.goto(publicOrigin+'/settings/cameras?camera='+camera.id);
      const orientationPanel=page.locator('article').filter({has:page.getByRole('heading',{name:'Image orientation',exact:true})});
      await expect(orientationPanel).toBeVisible();
      await orientationPanel.getByRole('button',{name:'Flip horizontally',exact:true}).click();
      await expect(orientationPanel.getByText('On',{exact:true})).toBeVisible();
      await orientationPanel.getByRole('button',{name:'Rotate clockwise',exact:true}).click();
      await expect(orientationPanel.getByText('90°',{exact:true})).toBeVisible();
      await orientationPanel.getByRole('button',{name:'Rotate counterclockwise',exact:true}).click();
      await expect(orientationPanel.getByText('0°',{exact:true})).toBeVisible();
      await page.getByRole('link',{name:'Recordings',exact:true}).first().click();
      await expect(page.getByRole('heading',{name:'SD card and storage'})).toBeVisible();
      await expect(page.getByText('64 GB',{exact:true})).toBeVisible();
      await expect(page.getByText('16 GB',{exact:true})).toBeVisible();
      await expect(page.locator('.recording-grid .recording-card')).toHaveCount(3);
      await page.locator('.recording-card').first().scrollIntoViewIfNeeded();
      await expect.poll(()=>page.locator('.recording-preview img').first().evaluate(image=>image.complete&&image.naturalWidth>0)).toBe(true);
      if(mode==='browser') await page.screenshot({path:test.info().outputPath('recordings-grid.png'),fullPage:true});
      await page.getByRole('button',{name:'Table',exact:true}).click();
      const recordingTable=page.locator('.recordings-table');
      await expect(recordingTable.getByRole('row')).toHaveCount(4);
      await expect(recordingTable.locator('time').first()).toHaveText('2026-11-1712:00:00');
      await page.reload();
      await expect(recordingTable).toBeVisible();
      const row=recordingTable.getByRole('row').nth(1);
      await page.mouse.move(0,0);
      const resting=await row.evaluate(element=>getComputedStyle(element).backgroundColor);
      await row.hover();
      await expect.poll(()=>row.evaluate(element=>getComputedStyle(element).backgroundColor)).not.toBe(resting);
      if(mode==='browser') await page.screenshot({path:test.info().outputPath('recordings-table.png'),fullPage:true});
      await page.getByRole('button',{name:'Play',exact:true}).first().click();
      const recordingDialog=page.getByRole('dialog',{name:/Recorded playback/});
      await expect(recordingDialog).toBeVisible();
      await expect(recordingDialog.getByRole('button',{name:'Previous recording',exact:true})).toBeDisabled();
      const recordingVideo=page.locator('video.recording-video');
      await expect(recordingVideo).toBeVisible();
      await expect.poll(() => recordingVideo.evaluate(video => video.readyState)).toBeGreaterThanOrEqual(1);
      const seek=await page.request.get(new URL(await recordingVideo.getAttribute('src'),publicOrigin).toString(),{headers:{range:'bytes=0-31'}});
      expect(seek.status()).toBe(206);
      expect((await seek.body()).length).toBe(32);
      if(mode==='browser') await page.screenshot({path:test.info().outputPath('recordings-player.png')});
      await recordingDialog.getByLabel('When the recording ends',{exact:true}).selectOption('next');
      await recordingVideo.evaluate(video=>video.dispatchEvent(new Event('ended')));
      await expect(recordingDialog.getByText('2026-11-17 12:01:00',{exact:true})).toBeVisible();
      await expect.poll(()=>recordingVideo.evaluate(video=>video.readyState)).toBeGreaterThanOrEqual(1);
      await recordingDialog.getByRole('button',{name:'Previous recording',exact:true}).click();
      await expect(recordingDialog.getByText('2026-11-17 12:00:00',{exact:true})).toBeVisible();
      await expect.poll(()=>recordingVideo.evaluate(video=>video.readyState)).toBeGreaterThanOrEqual(1);
      await recordingDialog.getByLabel('When the recording ends',{exact:true}).selectOption('loop');
      const recordingSource=await recordingVideo.getAttribute('src');
      await recordingVideo.evaluate(video=>{video.currentTime=1;video.dispatchEvent(new Event('ended'));});
      await expect.poll(()=>recordingVideo.evaluate(video=>video.currentTime)).toBeLessThan(.8);
      expect(await recordingVideo.getAttribute('src')).toBe(recordingSource);
      await recordingDialog.getByLabel('When the recording ends',{exact:true}).selectOption('stop');
      await recordingVideo.evaluate(video=>video.dispatchEvent(new Event('ended')));
      await expect(recordingDialog.getByText('2026-11-17 12:00:00',{exact:true})).toBeVisible();
      await page.mouse.click(2,2);
      await expect(recordingDialog).toHaveCount(0);
      let failVideo=true;
      const videoPath='**'+prefix+'/v1/cameras/*/recordings/*/video';
      await page.route(videoPath,route=> {
        if(!failVideo) return route.continue();
        failVideo=false;
        return route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({
          error:'MEDIA_UNAVAILABLE',correlationId:uuid(),details:{playbackReason:'conversion',upstreamStatus:502,bridgeCorrelationId:uuid()}
        })});
      });
      await page.getByRole('button',{name:'Play',exact:true}).first().click();
      await expect(recordingDialog.getByText('The bridge could not convert this recording to browser-playable video.')).toBeVisible();
      await expect(recordingVideo).toHaveCount(0);
      await recordingDialog.getByRole('button',{name:'Retry recording',exact:true}).click();
      await expect.poll(()=>recordingVideo.evaluate(video=>video.readyState)).toBeGreaterThanOrEqual(1);
      await recordingDialog.getByRole('button',{name:'Close',exact:true}).click();
      await page.unroute(videoPath);
      await page.getByRole('button',{name:'Grid',exact:true}).click();
      await expect(page.locator('.recording-grid')).toBeVisible();
      await page.setViewportSize({width:375,height:900});
      await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
      if(mode==='browser') await page.screenshot({path:test.info().outputPath('recordings-mobile.png'),fullPage:true});
      await page.getByRole('button',{name:'Play',exact:true}).first().click();
      await expect(recordingDialog).toBeVisible();
      expect((await recordingDialog.boundingBox()).width).toBeLessThanOrEqual(375);
      await recordingDialog.getByRole('button',{name:'Close',exact:true}).click();
      await page.setViewportSize({width:1280,height:720});
      bridge.setPlaybackAvailable(false);
      await runtime.ready();
      await page.reload();
      await expect(page.getByRole('button',{name:'Play',exact:true}).first()).toBeDisabled();
      await expect(page.getByText('64 GB',{exact:true})).toBeVisible();
      await expect(page.getByText(/Recording playback requires a writable temporary directory/)).toBeVisible();
      bridge.setPlaybackAvailable(true);
      await runtime.ready();
      await page.getByRole('button',{name:'Refresh',exact:true}).click();
      await expect(page.getByRole('button',{name:'Play',exact:true}).first()).toBeEnabled();
      await page.goto(publicOrigin+'/settings/enrollment');
      await page.getByLabel('Device UID').fill('TESTWUI001');
      const enrollmentButton = page.getByRole('button',{name:'Show enrollment QR'});
      const enrollmentQr = page.getByRole('dialog',{name:'WUI device enrollment code'});
      await enrollmentButton.click();
      await expect(enrollmentQr).toBeVisible();
      await enrollmentQr.getByRole('button',{name:'Close'}).click();
      await expect(enrollmentQr).toBeHidden();
      await enrollmentButton.click();
      await expect(enrollmentQr).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(enrollmentQr).toBeHidden();
      await expect(enrollmentButton).toBeFocused();

      await page.locator('summary').filter({hasText:'Wi-Fi join QR'}).click();
      await page.getByLabel('Wi-Fi network name').fill('Fixture Network QA');
      await page.getByLabel('Wi-Fi password').fill('fixture-wifi-password-123');
      await page.getByLabel('Camera code (last four characters)').fill('XY12');
      await page.getByRole('button',{name:'Generate Wi-Fi QR'}).click();
      const wifiQr = page.getByRole('dialog',{name:'Wi-Fi join QR'});
      const qr = page.locator('canvas[aria-label="Private Wi-Fi setup QR"]');
      await expect(wifiQr).toBeVisible();
      await expect(qr).toHaveJSProperty('width', 640);
      expect((await qr.boundingBox()).width).toBeGreaterThan(400);
      await expect(page.getByLabel('Wi-Fi password')).toHaveValue('');
      await page.mouse.click(2,2);
      await expect(wifiQr).toBeHidden();
      await expect(qr).toHaveJSProperty('width', 0);
      expect(JSON.stringify(observed)).not.toContain('fixture-wifi-password-123');
      expect(JSON.stringify(observed)).not.toContain('Fixture Network QA');

      await page.setViewportSize({width:375,height:812});
      await enrollmentButton.click();
      await expect(enrollmentQr).toBeVisible();
      expect((await enrollmentQr.boundingBox()).width).toBeLessThan(375);
      await page.keyboard.press('Escape');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
      expect(errors).toEqual([]);
      await page.getByRole('button',{name:'Sign out'}).click();
      await expect(page.getByRole('heading',{name:'Sign in'})).toBeVisible();
    } finally {
      if (!page.isClosed()) await page.close();
      edge?.closeAllConnections();
      edge?.close();
      if (ui.exitCode===null) { ui.kill(); await once(ui,'exit'); }
      app.server.closeAllConnections?.();
      await app.close();
      await bridge.close();
      await remoteBridge.close();
      await rm(directory,{recursive:true, force:true});
    }
  });
}
