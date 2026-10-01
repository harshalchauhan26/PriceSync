-- Reverts the currency-classification bug introduced by Decisions 007/008:
-- 39 brands were marked native-USD (meaning "trust this brand's own site as
-- already USD, don't convert") when in fact most of them are still priced in
-- INR on their own designer sites. That made the live-fetch pipeline compare
-- a correct USD base_price against a mislabeled raw INR number, producing
-- ~90x bogus "mismatches" (confirmed live on international.itrh.co: site
-- shows Rs. 144,000 / Rs. 372,000, correctly stored as live_price, but wrongly
-- labeled USD instead of being converted).
--
-- This does NOT touch base_price/base_currency/base_usd (those numbers, from
-- the Studio East export, are correct and stay as-is) — only how the pipeline
-- interprets each brand's OWN site during the next live fetch.
--
-- saakshakinni.com is deliberately left OUT of usd_convert_brands: Decision
-- 006 explicitly set it to stay INR-to-INR, with no special classification.

UPDATE meta SET v = '{"manijassal.com":"CAD","sapanaamin.com":"USD"}'
WHERE mbo_id = 1 AND k = 'native_currency_brands';

UPDATE meta SET v = 'svacouture.com,mahimamahajan.in,anushreereddydesign.com,shop.ridhimehra.com,sawangandhi.com,angadsinghofficial.com,international.itrh.co,houseofmasaba.com,paulmiandharsh.com,seemagujral.com,payalsinghal.com,chameeandpalak.in,aisharao.com,ekaya.in,ridhimehra.com,amitaggarwal.com,diyarajvvir.in,papadontpreach.com,coralhaze.com,thelittleblackbow.com,dollyjstudio.com,twentynine.co,vvanivats.com,gopivaid.com,drishtiandzahabia.com,jatinmalikcouture.com,labelanushree.com,tamannapunjabikapoor.com,gauravguptastudio.com,asukacouture.com,shlokakhialani.com,mymoledro.com,houseofarmuse.com,anitadongre.com,monikanidhee.com,us.anitadongre.com,falgunishanepeacock.in,studioeast6.com,rajattangri.com'
WHERE mbo_id = 1 AND k = 'usd_convert_brands';

-- Verify after running:
-- SELECT k, v FROM meta WHERE mbo_id = 1 AND k IN ('native_currency_brands','usd_convert_brands');
