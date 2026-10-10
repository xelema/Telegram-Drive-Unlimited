import {expect,test} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {desktopFixture,nativeCalls} from './desktop-fixture';

for(const locale of ['es','ar','ja'])test(`mobile supporter copy and purchase restoration are localized in ${locale}`,async ({page})=>{
  const catalog=JSON.parse(await readFile(new URL(`../../src/i18n/locales/${locale}.json`,import.meta.url),'utf8'));
  const copy=catalog.supporter_license;
  await page.setViewportSize({width:390,height:800});
  await desktopFixture(page,{supporterState:'expired',settings:{language:locale}});
  await page.goto(`/?a11y-fixture=supporter&purchase=mobile&locale=${locale}`);
  const main=page.locator(`[data-supporter-fixture-ready="${locale}"]`);await expect(main).toBeVisible();
  await expect(main.getByRole('heading',{name:copy.mobile_title,exact:true})).toBeVisible();
  await expect(main).toContainText(copy.mobile_description);
  expect(await main.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await expect(main.getByRole('button',{name:copy.purchase_action,exact:true})).toHaveCount(0);
  await main.getByText(copy.restore_heading_mobile,{exact:true}).click();
  const restore=main.getByRole('button',{name:copy.restore_action_mobile,exact:true});await expect(restore).toBeDisabled();
  await main.getByRole('textbox',{name:copy.recovery_code_label,exact:true}).fill('BROWSER-FIXTURE-NOT-A-REAL-CODE');
  await expect(restore).toBeDisabled();await main.getByRole('checkbox').check();await restore.click();
  await expect(main).toContainText(copy.active);
  await expect(main).toContainText(copy.android_updates_preserved);
  await expect(page.getByText(copy.purchase_restored,{exact:true})).toBeVisible();
  expect(await nativeCalls(page,'cmd_activate_supporter')).toHaveLength(1);
  expect(await nativeCalls(page,'cmd_begin_supporter_checkout')).toHaveLength(0);
});

test('startup steps and update notices use the saved language through the application',async({page})=>{
 await desktopFixture(page,{holdStartupHealth:true,update:true,settings:{language:'es'}});await page.goto('/');
 await expect(page.getByText('Comprobando servicios locales',{exact:true})).toBeVisible();
 await expect(page.getByText('Verificando la base de datos y el servicio de transmisión…',{exact:true})).toBeVisible();
 await expect(page.getByLabel('18% completado',{exact:true})).toBeVisible();
 expect(await nativeCalls(page,'cmd_connect')).toHaveLength(0);
 await page.evaluate(()=>{(window as any).__desktopTest.releaseStartupHealth();});
 await expect(page.getByText('Holiday folder photo.jpg',{exact:true})).toBeVisible({timeout:30_000});
 await expect(page.getByText('¡Hay una nueva versión (3.9.6) disponible!',{exact:true})).toBeVisible({timeout:15_000});
});

test('update phases, release notes and crash recovery react to language changes',async({page})=>{
 await desktopFixture(page);await page.goto('/?a11y-fixture=runtime-copy&locale=es');
 await expect(page.locator('[data-runtime-language="es"]')).toBeVisible();
 await page.getByRole('button',{name:'Download phase',exact:true}).click();
 await expect(page.getByText('Descargando actualización… 42%',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Verify phase',exact:true}).click();
 await expect(page.getByText('Verificando la actualización firmada…',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Install phase',exact:true}).click();
 await expect(page.getByText('Instalando actualización…',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Open release notes',exact:true}).click();
 const dialog=page.getByRole('dialog');await expect(dialog.getByRole('heading',{name:'Novedades de 4.0.0',exact:true})).toBeVisible();
 await expect(dialog).toContainText('La actualización firmada se verificó antes de instalarse.');
 await dialog.getByRole('button',{name:'Continuar',exact:true}).click();
 await page.getByRole('button',{name:'Fail rendering',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Algo salió mal',exact:true})).toBeVisible();
 await page.getByLabel('Fixture language').selectOption('ar');
 await expect(page.getByRole('heading',{name:'حدث خطأ',exact:true})).toBeVisible();
 await expect(page.getByText('جارٍ تثبيت التحديث…',{exact:true})).toBeVisible();
 await expect(page.locator('html')).toHaveAttribute('dir','rtl');
 await page.getByText('تفاصيل تقنية',{exact:true}).click();await expect(page.getByText('Controlled browser render failure',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>sessionStorage.getItem('telegram-drive-recovered-session'))).toBe('true');
 await page.getByRole('button',{name:'استعادة الجلسة',exact:true}).click();
 await expect(page.getByText('Healthy content',{exact:true})).toBeVisible();
 expect(await nativeCalls(page,'plugin:updater|install')).toHaveLength(0);
 expect(await nativeCalls(page,'cmd_begin_supporter_checkout')).toHaveLength(0);
});

test('the translated desktop preview keeps file navigation and zoom usable',async({page})=>{
 await desktopFixture(page,{extraPhoto:true,settings:{language:'es'}});await page.goto('/');
 await page.getByRole('group',{name:'Photos',exact:true}).click();
 await expect(page.getByRole('group',{name:'Holiday second photo.jpg',exact:true})).toBeVisible();
 const row=page.getByRole('group',{name:'Holiday folder photo.jpg',exact:true}).first();await expect(row).toBeVisible({timeout:30_000});
 await row.click({button:'right'});await page.getByRole('button',{name:'Vista previa',exact:true}).click();
 await expect(page.getByRole('button',{name:'Cerrar vista previa',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Archivo anterior',exact:true})).toBeAttached();
 await expect(page.getByRole('button',{name:'Archivo siguiente',exact:true})).toBeAttached();
 const zoom=page.getByRole('button',{name:/Zoom actual:/});
 const previousZoom=await zoom.getAttribute('aria-label');
 await page.getByRole('button',{name:'Acercar',exact:true}).click();
 await expect(zoom).not.toHaveAttribute('aria-label',previousZoom!);
 await page.getByRole('button',{name:'Archivo siguiente',exact:true}).click();
 await expect(page.getByRole('img',{name:'Holiday second photo.jpg',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Archivo anterior',exact:true}).click();
 await expect(page.getByRole('img',{name:'Holiday folder photo.jpg',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Cerrar vista previa',exact:true}).click();await expect(row).toBeVisible();
});

test('file deletion confirms and reports the outcome in the saved language',async({page})=>{
 await desktopFixture(page,{settings:{language:'es'}});await page.goto('/');
 await page.getByRole('group',{name:'Photos',exact:true}).click();
 const row=page.getByRole('group',{name:'Holiday folder photo.jpg',exact:true});await expect(row).toBeVisible();
 await row.click({button:'right'});await page.getByRole('button',{name:'Eliminar',exact:true}).click();
 const dialog=page.getByRole('dialog');await expect(dialog.getByRole('heading',{name:'Eliminar archivo',exact:true})).toBeVisible();
 await expect(dialog).toContainText('¿Seguro que quieres eliminar este archivo?');
 await dialog.getByRole('button',{name:'Eliminar',exact:true}).click();
 await expect(page.getByText('Archivo eliminado',{exact:true})).toBeVisible();
 expect(await nativeCalls(page,'cmd_delete_file')).toHaveLength(1);
});

test('download confirmation localizes its destination summary and cancellation creates no job',async({page})=>{
 await desktopFixture(page,{settings:{language:'es'}});await page.goto('/');await page.getByRole('group',{name:'Photos',exact:true}).click();
 const row=page.getByRole('group',{name:'Holiday folder photo.jpg',exact:true});await expect(row).toBeVisible();await row.click({button:'right'});
 await page.getByRole('button',{name:'Descargar',exact:true}).click();
 const dialog=page.getByRole('dialog');await expect(dialog.getByRole('heading',{name:'Confirmar descarga',exact:true})).toBeVisible();
 await expect(dialog).toContainText('Archivos: 1');await expect(dialog).toContainText('/synthetic/Downloads');
 await dialog.getByRole('button',{name:'Cancelar',exact:true}).click();await expect(dialog).toBeHidden();
 expect(await nativeCalls(page,'cmd_transfer_enqueue_many')).toHaveLength(0);await expect(row).toBeVisible();
});

test('the recovery drill presents localized instructions and verifies without importing a vault',async({page})=>{
 const catalog=JSON.parse(await readFile(new URL('../../src/i18n/locales/es.json',import.meta.url),'utf8'));
 await desktopFixture(page,{encryptionReady:true,vaultState:'unlocked',settings:{language:'es'}});await page.goto('/?a11y-fixture=settings');
 const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:catalog.settings.tab_encryption,exact:true}).click();
 await expect(dialog.getByRole('heading',{name:'Prueba obligatoria de recuperación',exact:true})).toBeVisible();
 await dialog.getByLabel('Contraseña del paquete de recuperación',{exact:true}).fill('translated-recovery-password');
 await dialog.getByRole('button',{name:'Crear paquete de recuperación',exact:true}).click();
 const bundle=await dialog.getByRole('textbox',{name:'Paquete de recuperación generado',exact:true}).inputValue();expect(bundle).not.toBe('');
 await dialog.getByText('He guardado este paquete fuera de este dispositivo.',{exact:true}).click();
 await dialog.getByRole('button',{name:'Continuar con la prueba de restauración',exact:true}).click();
 await dialog.getByRole('textbox',{name:'Paquete de recuperación que se verificará',exact:true}).fill(bundle);
 await dialog.getByLabel('Contraseña para verificar la recuperación',{exact:true}).fill('translated-recovery-password');
 await dialog.getByRole('button',{name:'Verificar y finalizar configuración',exact:true}).click();
 await expect(dialog.getByText('Prueba de restauración verificada',{exact:true})).toBeVisible();
 expect(await nativeCalls(page,'cmd_verify_vault_recovery')).toHaveLength(1);expect(await nativeCalls(page,'cmd_import_vault_recovery')).toHaveLength(0);
});

test('file favorites use translated menu labels and preserve the account-scoped action',async({page})=>{
 await desktopFixture(page,{settings:{language:'es'}});await page.goto('/');await page.getByRole('group',{name:'Photos',exact:true}).click();
 const row=page.getByRole('group',{name:'Holiday folder photo.jpg',exact:true});await expect(row).toBeVisible();await row.click({button:'right'});
 await page.getByRole('button',{name:'Añadir a Favoritos',exact:true}).click();
 await expect(page.getByText('Añadido a Favoritos',{exact:true})).toBeVisible();
 const calls=await nativeCalls(page,'cmd_set_file_activity_flag');expect(calls).toHaveLength(1);
 expect(calls[0].args).toMatchObject({flag:'favorite',value:true,ownerId:'101',folderId:9,messageId:42});
});

test('a loaded desktop language is published to native UI after the application applies it',async({page})=>{
 const es=JSON.parse(await readFile(new URL('../../src/i18n/locales/es.json',import.meta.url),'utf8'));
 await desktopFixture(page,{settings:{language:'es'}});await page.goto('/');await expect(page.getByRole('group',{name:'Holiday folder photo.jpg',exact:true})).toBeVisible();await expect(page.locator('html')).toHaveAttribute('lang','es');
 await expect.poll(async()=>{const calls=await nativeCalls(page,'cmd_set_native_language');return calls.at(-1)?.args.language;}).toBe('es');
 await page.getByRole('button',{name:es.common.preferences,exact:true}).click();await page.getByRole('menu').getByRole('button',{name:es.common.preferences,exact:true}).click();
 await page.getByRole('dialog').getByRole('combobox',{name:es.settings.app_language,exact:true}).selectOption('ar');
 await expect(page.locator('html')).toHaveAttribute('lang','ar');await expect(page.locator('html')).toHaveAttribute('dir','rtl');
 await expect.poll(async()=>{const calls=await nativeCalls(page,'cmd_set_native_language');return calls.at(-1)?.args.language;}).toBe('ar');
 expect(await nativeCalls(page,'cmd_begin_supporter_checkout')).toHaveLength(0);
});


test('the encryption explanation localizes safety details and returns focus without changing the vault',async({page})=>{
 const es=JSON.parse(await readFile(new URL('../../src/i18n/locales/es.json',import.meta.url),'utf8'));
 await desktopFixture(page,{encryptionReady:true,vaultState:'unlocked',settings:{language:'es',vaultRecoveryDrillCompleted:true,vaultRecoveryDrillVaultId:'fixture-vault'}});await page.goto('/?a11y-fixture=settings');
 const settings=page.getByRole('dialog');await settings.getByRole('button',{name:es.settings.tab_encryption,exact:true}).click();
 const opener=settings.getByRole('button',{name:new RegExp(es.workspace.protection+' '+es.ui_copy.how_it_works)});await opener.click();
 const explanation=page.getByRole('dialog',{name:'Cómo funciona la protección de archivos',exact:true});await expect(explanation).toBeVisible();
 await expect(explanation).toContainText('La protección se aplica en este dispositivo antes de subir el archivo.');
 await expect(explanation).toContainText('Telegram no puede recuperar tu clave.');
 await explanation.getByRole('button',{name:es.ui_copy.understood,exact:true}).focus();await page.keyboard.press('Escape');
 await expect(explanation).toHaveCount(0);await expect(opener).toBeFocused();
 expect(await nativeCalls(page,'cmd_lock_vault')).toHaveLength(0);expect(await nativeCalls(page,'cmd_import_vault_recovery')).toHaveLength(0);
});


test('local access explanations localize credential and encryption boundaries without enabling a server',async({page})=>{
 const es=JSON.parse(await readFile(new URL('../../src/i18n/locales/es.json',import.meta.url),'utf8'));
 await desktopFixture(page,{settings:{language:'es'}});await page.goto('/?a11y-fixture=tv-control');const outside=page.getByRole('button',{name:'Open settings',exact:true});await outside.click();
 const settings=page.getByRole('dialog');await settings.getByRole('button',{name:es.settings.tab_advanced,exact:true}).click();await settings.getByRole('button',{name:/^REST API/}).click();const opener=settings.getByRole('button',{name:es.access_copy?.rest_open ?? 'Understand REST permissions',exact:true});await opener.click();
 const explanation=page.getByRole('dialog',{name:'Cómo funciona el acceso REST',exact:true});await expect(explanation).toBeVisible();
 await expect(explanation).toContainText('Cada solicitud debe incluir la clave de API generada.');
 await expect(explanation).toContainText('el acceso local no evita el cifrado.');
 await page.keyboard.press('Escape');await expect(explanation).toHaveCount(0);await expect(opener).toBeFocused();await page.keyboard.press('Tab');expect(await settings.evaluate(element=>element.contains(document.activeElement))).toBe(true);
 await settings.getByRole('button',{name:es.settings.tab_advanced,exact:true}).click();await settings.getByRole('button',{name:/^WebDAV/}).click();
 await settings.getByRole('button',{name:es.access_copy?.webdav_open ?? 'Understand WebDAV permissions',exact:true}).click();
 const dav=page.getByRole('dialog',{name:'Cómo funciona el acceso WebDAV',exact:true});await expect(dav).toBeVisible();
 await expect(dav).toContainText('/dav/<token>/');await expect(dav).toContainText('El acceso como invitado o anónimo sin ese token no está permitido.');
 await dav.getByRole('button',{name:es.ui_copy.understood,exact:true}).click();await expect(dav).toHaveCount(0);await page.keyboard.press('Escape');await expect(settings).toHaveCount(0);await expect(outside).toBeFocused();
 expect(await nativeCalls(page,'cmd_set_api_settings')).toHaveLength(0);expect(await nativeCalls(page,'cmd_set_webdav_settings')).toHaveLength(0);
});


test('upload storage choice is localized and cancellation creates no transfer',async({page})=>{
 const es=JSON.parse(await readFile(new URL('../../src/i18n/locales/es.json',import.meta.url),'utf8'));
 await desktopFixture(page,{settings:{language:'es'}});await page.goto('/');await page.getByRole('group',{name:'Photos',exact:true}).click();
 await page.getByRole('button',{name:es.common.upload,exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'¿Cómo quieres almacenar la selección? Archivos: 1',exact:true});await expect(dialog).toBeVisible();
 await expect(dialog).toContainText('Puedes conservar el archivo original');
 await expect(dialog.getByRole('button',{name:/^Almacenar y proteger/})).toBeVisible();
 await dialog.getByRole('button',{name:es.common.cancel,exact:true}).click();await expect(dialog).toHaveCount(0);
 expect(await nativeCalls(page,'cmd_transfer_enqueue_many')).toHaveLength(0);expect(await nativeCalls(page,'cmd_stage_file_passphrase')).toHaveLength(0);
});
