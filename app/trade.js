const fs = require('fs');
const TradeOfferManager = require('steam-tradeoffer-manager');
const backpack = require('./backpacktf');
const AutomaticOffer = require('./automatic-offer');

const POLLDATA_FILENAME = 'polldata.json';

let manager, log, Config;

exports.register = (Automatic) => {
    log = Automatic.log;
    manager = Automatic.manager;
    Config = Automatic.config;

    if (fs.existsSync(POLLDATA_FILENAME)) {
        try {
            manager.pollData = JSON.parse(fs.readFileSync(POLLDATA_FILENAME));
        } catch (e) {
            log.verbose("polldata.json is corrupt: ", e);
        }
    }

    manager.on('pollData', savePollData);
    manager.on('newOffer', handleOffer);
    manager.on('receivedOfferChanged', offerStateChanged);
};

function savePollData(pollData) {
    fs.writeFile(POLLDATA_FILENAME, JSON.stringify(pollData), (err) => {
        if (err) log.warn("Error writing poll data: " + err);
    });
}

function handleOffer(tradeoffer) {
    const offer = new AutomaticOffer(tradeoffer);
    if (offer.isGlitched()) {
        offer.log("warn", `received from ${offer.partner64()} is glitched (Steam might be down).`);
        return;
    }

    offer.log("info", `received from ${offer.partner64()}`);

    if (offer.fromOwner()) {
        offer.log("info", `is from owner, accepting`);
        offer.accept().then((status) => {
            offer.log("trade", `successfully accepted${status === 'pending' ? "; confirmation required" : ""}`);
            log.debug("Owner offer: not sending confirmation to backpack.tf");
        }).catch((msg) => {
            offer.log("warn", `(owner offer) couldn't be accepted: ${msg}`);
        });
        return;
    }
    
    if (offer.isOneSided()) {
        if (offer.isGiftOffer() && Config.get("acceptGifts")) {
            offer.log("info", `is a gift offer asking for nothing in return, will accept`);
            offer.accept().then((status) => {
                offer.log("trade", `(gift offer) successfully accepted${status === 'pending' ? "; confirmation required" : ""}`);
                log.debug("Gift offer: not sending confirmation to backpack.tf");
            }).catch((msg) => {
                offer.log("warn", `(gift offer) couldn't be accepted: ${msg}`);
            });
        } else {
            offer.log("info", "is a gift offer, skipping");
        }
        return;
    }
    
    if (offer.games.length !== 1 || offer.games[0] !== 440) {
        if (offer.games[0] !== 753 && offer.games.length === 1) {
            offer.log("info", `contains non-TF2 or steam items, skipping`);
        }
        else {
            let keepGoing = true;
            for (let i = 0; i < offer.exchange.ours.length; i += 1) {
                let item = offer.exchange.ours[i];
                if (AutomaticOffer.isMetal(item) || AutomaticOffer.isGems(item) || AutomaticOffer.isSackOfGems(item) || AutomaticOffer.isKey(item) || AutomaticOffer.isCSGOKey(item))
                    continue;
                else
                    keepGoing = false;
            }
            if (keepGoing)
            {
                let ourgems = offer.gems.ours;
                let theirgems = offer.gems.theirs;
                let ourmetal = offer.currencies.ours.metal;
                let ourtf2keys = offer.currencies.ours.keys;
                let theirmetal = offer.currencies.theirs.metal;
                let theirtf2keys = offer.currencies.theirs.keys;
                let ourcsgokeys = offer.csgokeys.ours;
                let theircsgokeys = offer.csgokeys.theirs;
                if (theirgems > 0 && ourgems === 0) { //Comprando gemas
                    theirgems -= ourtf2keys * Config.get("buyGemsTF2Key");
                    theirgems -= ourmetal * Config.get("buyGemsRef");
                    theirgems -= ourcsgokeys * Config.get("buyGemsCSGOKey");
                    theirgems = Math.round(theirgems * 100) / 100;
                    if (theirgems >= 0)
                    {
                        offer.log("debug", `just bought ${offer.gems.theirs} gems`);
                        offer.log("debug", `finalizing offer`);
                        backpack.finalizeOffer(offer);
                    }
                    else
                    {
                        offer.log("info", `the amount of gems or ref does not match`);
                    }
                    return;
                }
                else if (ourgems > 0 && theirgems === 0) { //Vendiendo gemas
                    ourgems -= theirtf2keys * Config.get("sellGemsTF2Key");
                    ourgems -= theirmetal * Config.get("sellGemsRef");
                    ourgems -= theircsgokeys * Config.get("sellGemsCSGOKey");
                    ourgems = Math.round(ourgems * 100) / 100;
                    if (ourgems <= 0)
                    {
                        offer.log("debug", `just sold ${offer.gems.ours} gems`);
                        offer.log("debug", `finalizing offer`);
                        backpack.finalizeOffer(offer);
                    }
                    else
                    {
                        offer.log("info", `the amount of gems or ref does not match`);
                    }
                    return;
                }
                else if ((ourcsgokeys !== 0 || theircsgokeys !== 0) || (theirtf2keys !== 0 || ourtf2keys !== 0) || (theirmetal !== 0 || ourmetal !== 0) && ourgems === 0) //Cambiando keys de CS:GO
                {
                    let theirTotalMetal = theirmetal + theirtf2keys * Config.get("TF2KeyRefPrice") + theircsgokeys * Config.get("sellCSGORefPrice");
                    let ourTotalMetal = ourmetal + ourtf2keys * Config.get("TF2KeyRefPrice") + ourcsgokeys * Config.get("buyCSGORefPrice");
                    theirTotalMetal = Math.round(theirTotalMetal * 100) / 100;
                    ourTotalMetal = Math.round(ourTotalMetal * 100) / 100;
                    if (theirTotalMetal >= ourTotalMetal)
                    {
                        offer.log("debug", `finalizing offer`);
                        backpack.finalizeOffer(offer);
                    }
                    else
                    {
                        offer.log("info", `quantity of ref or keys does not match`);
                    }
                    return;
                }
            }
        }
    }

    offer.log("debug", `handling buy orders`);
    let ok = backpack.handleBuyOrdersFor(offer);
    if (ok === false) return;
    offer.log("debug", `handling sell orders`);
    backpack.handleSellOrdersFor(offer).then((ok) => {
        if (ok) {
            offer.log("debug", `finalizing offer`);
            backpack.finalizeOffer(offer);
        }
    });
}

function offerStateChanged(tradeoffer, oldState) {
    const offer = new AutomaticOffer(tradeoffer, {countCurrency: false});
    offer.log("verbose", `state changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${offer.stateName()}`);

    if (offer.state() === TradeOfferManager.ETradeOfferState.InvalidItems) {
        offer.log("info", "is now invalid, declining");
        offer.decline().then(() => offer.log("debug", "declined")).catch(() => offer.log("info", "(Offer was marked invalid after being accepted)"));
    }
}

