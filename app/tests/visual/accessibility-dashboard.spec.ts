import {expect,test} from '@playwright/test';
import axe from 'axe-core';
import {desktopFixture} from '../e2e/desktop-fixture';

test('the Arabic RTL dashboard has named controls, no axe violations and no horizontal overflow',async ({page})=>{
  await page.clock.install({time:new Date('2026-10-02T12:00:00Z')});
  await desktopFixture(page,{settings:{language:'ar'}});await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg',{exact:true})).toBeVisible({timeout:30_000});
  await expect(page.locator('html')).toHaveAttribute('dir','rtl');
  await page.clock.runFor(10_000);
  await page.evaluate(()=>document.fonts.ready);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.addScriptTag({content:axe.source});
  const violations=await page.evaluate(async()=>{
    const result=await (window as any).axe.run(document);
    return result.violations.map((violation:any)=>({id:violation.id,nodes:violation.nodes.map((node:any)=>({target:node.target,html:node.html,failureSummary:node.failureSummary}))}));
  });
  expect(violations).toEqual([]);
  await expect(page).toHaveScreenshot('dashboard-arabic-rtl.png',{animations:'disabled'});
  await page.keyboard.press('Tab');await expect(page.locator(':focus-visible')).toBeVisible();
});
