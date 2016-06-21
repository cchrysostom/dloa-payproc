# paywall-web Alexandria Payment Processor

## Installation

**Install dependencies**

```
npm install blocktrail-sdk
```

**Copy the payproc.sample.conf file to payproc.conf and edit it.**

```
$ cp payproc.sample.conf payproc.conf
$ vi payproc.conf
{
	"config": {
		"API_KEY": "blocktrail api key",
		"API_SECRET": "blocktrail secret",
		"WALLET_NAME": "the wallet name",
		"WALLET_PASSWORD": "the wallet password",
		"USE_TESTNET": true,
		"PORT": 11306,
		"DB_FILE": "payproc.db",
		"FORWARD_BAL_THRESHOLD": 143900,
		"FWD_PAY_DELAY": 600000
	}
}
```

* Adjust the settings to match your Blocktrail information and the server's port number.
* The configuration, FORWARD_BAL_THRESHOLD, is in Satoshis (1 BTC = 100,000,000 Satoshis).
* FWD_PAY_DELAY is number of milliseconds to between payment forwarding scans.


**Run the server**

```
node payproc.js
```

## Usage

### /payproc/receive

To generate a receive address for payments, use /payproc/receive.

```
$ curl "http://localhost:11306/payproc/receive?address=2N4ajxiM1xHc83mehV2LTXk2Z65TAfc9MhX&amount=0.432"
{"input_address":"2N6dDdHGx24ss6AoAqjx8gnc2JQpETe1mBp"}
```

Parameters:

**address** _Address to receive coins_

**amount** _Amount to send to address in BTC_

Return:

**temporary address** _The temporary address that can be shown to the buyer._

### /payproc/getreceivedbyaddress

To check the total amount of the unconfirmed balance of the given BTC address:

```
$ curl "http://localhost:11306/payproc/getreceivedbyaddress/2N4ajxiM1xHc83mehV2LTXk2Z65TAfc9MhX"
0.00000000
```

Path Parameter:

/payproc/getreceivedbyaddress/**[BTC ADDRESS]**  _The temporary payment address to monitor._

Return:

The unconfirmed balance in BTC.

###
