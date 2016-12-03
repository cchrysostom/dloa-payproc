/*
    DLOA Payment Processor

    Handles payments for Alexandria.

*/
/* jshint esversion: 6 */
/* jshint node: true */
"use strict";
let blocktrail = require('blocktrail-sdk');
let http = require('http');
let querystring = require('querystring');
let fs = require('fs');
let winston = require('winston');

let configuration;
let API_KEY = "";
let API_SECRET = "";
let WALLET_NAME = "";
let WALLET_PASSWORD = "";
let USE_TESTNET = true;
let PORT = 11306;
let DB_FILE = "payproc.db";
let FORWARD_BAL_THRESHOLD = 136000;    //TODO: Set this value to $1.00 worth of Satoshis, query market value

let PYMT_ADDR_ROTATION_IMPLEMENTED = false;

const URL_RECEIVE = "/payproc/receive";
const URL_RECEIVED_BYADDRESS = "/payproc/getreceivedbyaddress";
const URL_PING = "/payproc/ping";

let FWD_PAY_DELAY = 10 * 60 * 1000; // 10 minutes
const STATUS_CHECKED_OUT = 0;
const STATUS_CHECKED_IN = 1;
const FORWARDED_FALSE = 0;
const FORWARDED_TRUE = 1;

let client;
let payWallet;
let forwardAddressMap = new Map(); // Key: source address, Value: forwarding destination address
let addressRecvAmtMap = new Map(); // Key: temporary receive address, Value: payment amount in Satoshis
let temporaryAddressMap = new Map(); // Key: forward to receive address, Value: temporary receive address

let server;
let continueForwardingPayments = false; // Use this flag to stop forwarding
let forwardPaymentsTimeout;
let payprocDb;

let logger = new (winston.Logger)({
    transports: [
      new (winston.transports.Console)({ colorize: true , timestamp: true}),
      new (winston.transports.File)({ name: 'info-log', filename: 'payproc.log', timestamp: true, level: 'info', maxsize: 26214400, maxFiles: 5 }),
      new (winston.transports.File)({ name: 'debug-log', filename: 'payproc.debug.log', timestamp: true, level: 'debug', maxsize: 26214400, maxFiles: 5 })
    ]
  });

// Configure and start server
configure(runServer);

/**
 * Configures settings for payproc server.
 * 
 * @param  {function} Function to invoke after reading configuration.
 *
 */
function configure(configReady) {

	logger.debug('Configuring payproc.');
	fs.readFile('payproc.conf', 'utf8', function(err, contents) {
		if (err) {
			logger.error(err);
			return false;
		}

		configuration = JSON.parse(contents);

		API_KEY = configuration.config.API_KEY;
		API_SECRET = configuration.config.API_SECRET;
		WALLET_NAME = configuration.config.WALLET_NAME;
		WALLET_PASSWORD = configuration.config.WALLET_PASSWORD;
		USE_TESTNET = configuration.config.USE_TESTNET;
		PORT = configuration.config.PORT;
		DB_FILE = configuration.config.DB_FILE;
        FORWARD_BAL_THRESHOLD = configuration.config.FORWARD_BAL_THRESHOLD;
        FWD_PAY_DELAY = configuration.config.FWD_PAY_DELAY;
        
		configReady();
	});
}

function runServer() {
	client = blocktrail.BlocktrailSDK({
		apiKey: API_KEY,
		apiSecret: API_SECRET,
		testnet: USE_TESTNET
	});
	client.initWallet(WALLET_NAME, WALLET_PASSWORD, setPayWallet);

	// Setup database
	dbSetup();

	// Create a server
	server = http.createServer(handleRequest);

	// Lets start our server
	server.listen(PORT, function() {
		logger.info("Server listening on port, %s.", PORT);
	});

	// Start funds forward process
	// Disabled temporarily, issue #10
	//forwardPaymentsTimeout = setTimeout(forwardPayments, FWD_PAY_DELAY);
}

function dbSetup() {
	let fs = require("fs");
	let exists = fs.existsSync(DB_FILE);

	if (!exists) {
		DB_FILE = "payproc.db";
		logger.debug("Creating DB file, %s.", DB_FILE);
		fs.openSync(DB_FILE, "w");
	}

	let sqlite3 = require("sqlite3").verbose();
	payprocDb = new sqlite3.Database(DB_FILE);

	payprocDb.serialize(function() {
		if (!exists) {
			payprocDb.run("CREATE TABLE PaymentAddress (destinationAddress TEXT, paymentAddress TEXT, targetBalance INTEGER, payableBalance INTEGER, status INTEGER, forwarded INTEGER)");
		}
		payprocDb.all("SELECT * FROM PaymentAddress", function(err, rows) {
			logger.debug("SELECT * FROM PaymentAddress", rows);
		})
	});
}

function setPayWallet(err, wallet) {
	if (err) {
		return logger.error('initWallet ERR', err);
	} else {
		logger.info('Wallet, %s, initialized.', WALLET_NAME);
	}
	payWallet = wallet;
	logger.debug("Wallet initialized.");
}

function payWalletBalance(balanceCb) {
	if (payWallet === undefined) {
		setTimeout(payWalletBalance, 250);
		return;
	}

	payWallet.getBalance().then(function(balance) {
			logger.debug('Balance: ', blocktrail.toBTC(balance[0]));
			balanceCb(blocktrail.toBTC(balance[0]));
		},
		handleError);

}


function addressBalance(address, balanceCb) {
	if (client === undefined) {
		setTimeout(addressBalance(address, balanceCb), 250);
	}

	client.address(address).then(function(address) {
			logger.debug("Address: ", address, ", Balance: ", address.balance);
			balanceCb(address.balance);
		},
		handleError);
}

function addressUnconfirmedReceived(address, unconfRecvd) {
	if (client === undefined) {
		setTimeout(addressUnconfirmedReceived(address, unconfRecvd), 250);
	}

	client.address(address).then(function(address) {
			logger.debug("Address: ", address, ", Unconfirmed: ", address.unconfirmed_received);
			unconfRecvd(address.unconfirmed_received);
		},
		handleError);
}

function mapAddressForwarding(sourceAddress, destAddress) {
	forwardAddressMap.set(sourceAddress, destAddress);
}

function mapTemporaryAddress(receiveAddress, tempAddress) {
	temporaryAddressMap.set(receiveAddress, tempAddress);
}

function mapTempAddressRecvAmount(tempAddress, amountSatoshis) {
	addressRecvAmtMap.set(tempAddress, amountSatoshis);
}

function handleError(err) {
	console.error(err);
}

function receivePayment(recvAddress, amountBTC, addressCb) {
	if (payWallet === undefined) {
		setTimeout(receivePayment(recvAddress, amountBTC, addressCb), 250);
		return;
	}
    let amountSatoshis = blocktrail.toSatoshi(amountBTC);

    // Attempt to retrieve temporary payment address from repository
 	retrieveNextPaymentAddress(recvAddress, amountSatoshis, addressCb);

}

// Parameters
//     recvAddress    Bitcoin address of publisher (or final target)
//     pymtAmt        Excepted payment amount in Satoshis
//     pymtAddrCb     Callback function invoked with pymyAddrCb(pymtAddr)
//
//     TODO: Temporarily, payment addresses will be used only once. Thus, status will also be STATUS_CHECKED_OUT until implementation of
//     rotating payment addresses is complete.     
function retrieveNextPaymentAddress(recvAddress, pymtAmt, pymtAddrCb) {


	if (PYMT_ADDR_ROTATION_IMPLEMENTED) {

		let stmt = payprocDb.prepare("SELECT paymentAddress, targetBalance FROM PaymentAddress WHERE destinationAddress = ? AND status = ?");

		stmt.get(recvAddress, STATUS_CHECKED_IN, function(err, row) {
			let pymtAddr;
			let targetBal = 0;           // In Satoshis

			// Handle no available payment address to use
			if (row === undefined) {
				payWallet.getNewAddress().then(function(address, path) {
					logger.info("Created new payment address, " + address + ".");
					pymtAddr = address[0];
					targetBal += pymtAmt;
					let insertStmt = payprocDb.prepare("INSERT INTO PaymentAddress (destinationAddress, paymentAddress, status, targetBalance, payableBalance, forwarded) VALUES (?, ?, ?, ?, ?, ?)");
					insertStmt.run(recvAddress, pymtAddr, STATUS_CHECKED_OUT, targetBal, pymtAmt, FORWARDED_FALSE);
					insertStmt.finalize();

				});
			} else {

				pymtAddr = row.paymentAddress;

				addressBalance(pymtAddr, function(confirmedBal) {
					targetBal = confirmedBal;
					targetBal += pymtAmt;

					// TODO: Test whether this could setup a race condition, counting on Node.js serving http single threaded.
					let updateStmt = payprocDb.prepare("UPDATE PaymentAddress SET status = ?, targetBalance = ? WHERE paymentAddress = ?");
					updateStmt.run(STATUS_CHECKED_OUT, targetBal, pymtAddr);
					updateStmt.finalize();
				});
				pymtAddrCb(pymtAddr);
			}
			
		});

	} else {

			let pymtAddr;
			let targetBal = 0;           // In Satoshis

			payWallet.getNewAddress().then(function(address, path) {
				logger.info("Created new payment address, " + address + ".");
				pymtAddr = address[0];
				targetBal += pymtAmt;
				let insertStmt = payprocDb.prepare("INSERT INTO PaymentAddress (destinationAddress, paymentAddress, status, targetBalance, payableBalance, forwarded) VALUES (?, ?, ?, ?, ?, ?)");
				insertStmt.run(recvAddress, pymtAddr, STATUS_CHECKED_OUT, targetBal, pymtAmt, FORWARDED_FALSE);
				insertStmt.finalize();
				pymtAddrCb(address);
			});	
	}

}

function addNewPaymentAddress(recvAddress, pmtAddress, targetAmtBTC) {
	let targetSatoshis = blocktrail.toSatoshi(targetAmtBTC);
	let stmt = payprocDb.prepare("INSERT INTO PaymentAddress (destinationAddress, paymentAddress, status, startUnconfBal, targetBalance) VALUES (?, ?, ?, ?, ?)");
	stmt.run(recvAddress, pmtAddress, STATUS_CHECKED_IN, 0, targetSatoshis);
	stmt.finalize();
}

// TODO: Implement forward payments like https://gist.github.com/rubensayshi/35e45d4a843a8f9409e2
function forwardPayments() {
	if (!continueForwardingPayments) {
		clearTimeout(forwardPaymentsTimeout);
		continueForwardingPayments = false;
		return false;
	}

	logger.info("forwardPayments invoked");
	/*
	
	for each destAddress

		pymtRecvSum = 0

		for each pymtAddr in destAddress
			get pymtAddr.balance
			if pymtAddr.balance >= payableBalance
			    set payableBalance = 0
			    set forwarded = FORWARDED_TRUE
			    pymtRecvSum += pymtAddr.balance
			else
				set payableBalance = payableBalance - pymtAddr.balance

			
		if pymtRecvSum > FORWARD_BAL_THRESHOLD
		    wallet.pay pymtRecvSum to destAddress


	 */

	 let destAddSelectSql = 'SELECT destinationAddress, paymentAddress, targetBalance, payableBalance, status' +
	                        '    FROM PaymentAddress WHERE forwarded = ?' +
	                        '    ORDER BY destinationAddress, paymentAddress';
	 let destAddrSelect = payprocDb.prepare(destAddSelectSql);
	 destAddrSelect.all(FORWARDED_FALSE, forwardDestAddresses);


	forwardPaymentsTimeout = setTimeout(forwardPayments, FWD_PAY_DELAY);
}


function forwardDestAddresses(err, rows) {
	logger.debug("forwardDestAddresses: rows: ", rows);
	let destAddrMap = new Map();

    for (let i = 0; i < rows.length; i++) {
      if (destAddrMap.get(rows[i].destinationAddress) === undefined) {
        destAddrMap.set(rows[i].destinationAddress, new Map());
      }
      destAddrMap.get(rows[i].destinationAddress).set(rows[i].paymentAddress, rows[i]);
    }

    for (let destAddr of destAddrMap.keys()) {
    	let pymtRecvSum = 0;
    	let updateCount = 0; 

    	for (let pymtAddr of destAddrMap.get(destAddr).keys()) {
			// Async / await here
    		logger.info(">>>> destAddr: " + destAddr + ", pymtAddr: " + pymtAddr);
    		addressBalance(pymtAddr, function(balance) {
    			if (balance >= destAddrMap.get(destAddr).get(pymtAddr).payableBalance) {
    				logger.info("Payment address, " + pymtAddr + ", balance >= destAddrmap.get(pymtAddr).payableBalance: " + destAddrMap.get(destAddr).get(pymtAddr).payableBalance);
    				let updateStmt = payprocDb.prepare("UPDATE PaymentAddress SET payableBalance = ?, forwarded = ? WHERE paymentAddress = ?");
    				updateStmt.run(0, FORWARDED_TRUE, pymtAddr);
    				pymtRecvSum += balance;

    			} else {
    				logger.debug("Payment address," + pymtAddr + " balance < payableBallance: " + destAddrMap.get(destAddr).get(pymtAddr).payableBalance);
    				let updatedPayableBal = destAddrMap.get(destAddr).get(pymtAddr).payableBalance - balance;
    				let updateStmt = payprocDb.prepare("UPDATE PaymentAddress SET payableBalance = ? WHERE paymentAddress =?");
    				updateStmt.run(updatedPayableBal, pymtAddr);
    			}

    			++updateCount;
    			logger.debug("updataeCount: ", updateCount, "size: ", destAddrMap.get(destAddr).size);
    			if (updateCount >= destAddrMap.get(destAddr).size) {
    				onPaymentRecvSum(pymtRecvSum, destAddr);
    			}
    		});
    	}

    }
}


function onPaymentRecvSum(pymtRecvSum, destAddr) {
	if (pymtRecvSum > FORWARD_BAL_THRESHOLD) {
		logger.info("onPaymentRecvSum pymtRecvSum > FORWARD_BAL_THRESHOLD " + pymtRecvSum + " for address " + destAddr);
		let pay = {};
		pay[destAddr] = pymtRecvSum;
		payWallet.pay(pay, function(err, result) {
			if (err) {
            	logger.error("Payment error: " + err);
            	return;
        	}
        	logger.info("Forward payment transaction " + result);				
		});
	}

}

// Main request handler
function handleRequest(request, response) {
	logger.info("Received request, " + request.url);
	if (request.url.indexOf(URL_RECEIVE) === 0) {
		handleReceiveCreateAddress(request, response);
	} else if (request.url.indexOf(URL_RECEIVED_BYADDRESS) === 0) {
		handleGetReceivedByAddress(request, response);
	} else if (request.url.indexOf(URL_PING) === 0) {
		handlePing(request, response);
	} else {
		response.statusCode = 404;
		response.statusMessage = "Not found";
		response.end("Error");
	}
}

function handleReceiveCreateAddress(request, response) {
	let query = request.url.substring(request.url.indexOf("?") + 1);
	let param = querystring.parse(query);
	receivePayment(param.address, param.amount, function(tempAddress) {
		var addressObject = {
			input_address: tempAddress[0]
		};
		var jsonData = JSON.stringify(addressObject);
		response.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
		response.setHeader('Content-Type', 'application/json');
		response.statusCode = 200;
		response.write(jsonData);
		response.end();
	});

}

function handleGetReceivedByAddress(request, response) {
	let recvAddress = request.url.substring(URL_RECEIVED_BYADDRESS.length + 1);
	addressUnconfirmedReceived(recvAddress, function(balanceSatoshis) {
		logger.debug("handleGetReceivedByAddress   Address: " + recvAddress + ", Unconfimed balance (Satoshis): " + balanceSatoshis);
		response.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
		response.setHeader('Content-Type', 'text/plain');
		response.statusCode = 200;
		response.end(blocktrail.toBTC(balanceSatoshis));
	});
}

function handlePing(request, response) {
	logger.info("Received ping from " + request.socket.remoteAddress);
	response.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
	response.setHeader('Content-Type', 'text/plain');
	response.statusCode = 200;
	response.end("ALIVE");
}

