'use strict';

var Logger = require('dw/system/Logger').getLogger('Stripe', 'stripe');
var System = require('dw/system');
var dworder = require('dw/order');
var Status = require('dw/system/Status');
var Transaction = require('dw/system/Transaction');
var PaymentMgr = require('dw/order/PaymentMgr');

var Stripe = require('~/cartridge/scripts/service/stripe');
 
exports.authorizeCreditCard = function (order, paymentDetails) : Status {
    Logger.debug("@@@@@ authorizeCreditCard hook order =" + order + " paymentinstrument =" + paymentDetails);
    try {

	    var params = {
	    		Order: order,
	    		PaymentInstrument: paymentDetails
	    };
	    var orderNo = order.orderNo;
	    var paymentInstrument = paymentDetails;
	    var paymentProcessor = PaymentMgr.getPaymentMethod(paymentInstrument.getPaymentMethod()).getPaymentProcessor();
	
	    if (System.Site.getCurrent().getCustomPreferenceValue('stripeRELAYProcessAuthorization')) {
	        var result = Stripe.AuthorizePayment(params);
	        Transaction.wrap(function () {
	            paymentInstrument.paymentTransaction.transactionID = result.transactionID;
	            paymentInstrument.paymentTransaction.paymentProcessor = paymentProcessor;
	        });
	    } else {
	        Transaction.wrap(function () {
	            paymentInstrument.paymentTransaction.transactionID = orderNo;
	            paymentInstrument.paymentTransaction.paymentProcessor = paymentProcessor;
	        });
			
		}
    } catch (e) {
    	Logger.error("Error: " + e.message);
    }

    return new Status(Status.OK);
}