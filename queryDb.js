"use strict";
let fs = require('fs');
let DB_FILE = "payproc.db";

queryPaymentAddress();

function queryPaymentAddress() {
	let fs = require("fs");
	let exists = fs.existsSync(DB_FILE);

	if (!exists) {
		DB_FILE = "payproc.db";
		console.log("Creating DB file, " + DB_FILE + ".");
		fs.openSync(DB_FILE, "w");
	}

	let sqlite3 = require("sqlite3").verbose();
	let payprocDb = new sqlite3.Database(DB_FILE);

	payprocDb.serialize(function() {
		if (!exists) {
			payprocDb.run("CREATE TABLE PaymentAddress (destinationAddress TEXT, paymentAddress TEXT, targetBalance INTEGER, payableBalance INTEGER, status INTEGER, forwarded INTEGER)");
		}
		console.log("destinationAddress\tpaymentAddress\ttargetBalance\tpayableBalance\tstatus\tforwarded");
		payprocDb.each("SELECT * FROM PaymentAddress", function(err, row) {
			console.log(row.destinationAddress + "\t" + row.paymentAddress + "\t" + row.targetBalance + "\t" + row.payableBalance + "\t" + row.status + "\t" + row.forwarded);
		});

	});
}
